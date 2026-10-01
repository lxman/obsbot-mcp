import { createSocket } from "node:dgram";

/**
 * The Tail 2's SECOND control plane: the private UDP 9999 protocol that
 * OBSBOT Center speaks (TAIL2-PROTOCOL.md §10). Everything the REST API
 * exposes has a tool already; this channel carries the controls it does
 * NOT — starting with the hybrid-zoom unlock, which exists nowhere in the
 * REST tree (a full endpoint diff during a Center flip shows zero changes,
 * yet `PUT ptz/zoom` silently pins at the 5.0x optical ceiling unless this
 * frame has been sent).
 *
 * Write-frame anatomy (26-byte control write, offsets):
 *
 *   aa                       magic
 *   25                       frame type (write)
 *   <seq lo> <seq hi>        uint16 LE sequence (arbitrary; fresh is fine)
 *   14 00                    header constant
 *   <ck hi> <ck lo>          frame checksum — CRACKED, see frameChecksum()
 *   0c 02 82 c1              command id (the zoom-family control)
 *   02 06 a7 71 df 1c        TLV: sender identity (constant from the capture)
 *   03 57                    TLV terminator
 *   02 00                    TLV: value length = 2
 *   <ck hi> <ck lo>          TLV value checksum — CRACKED, see tlvValueChecksum()
 *   <subcmd> <value>         subcmd 01 = hybrid-zoom enable (value 0/1);
 *                            subcmd 00 = PROBABLY Manual Zoom Speed 1-10
 *                            (ust.json persists manual_zoom_speed=7, a value
 *                            from the captured sweep — labeled capture still
 *                            pending; see TAIL2-PROTOCOL.md §10a)
 *
 * Both checksums and the sequence are computed, so frames are synthesized,
 * not replayed — hardware-verified 2026-09-30 with a fresh random sequence,
 * including with OBSBOT Center fully closed (the sender-identity constant
 * is a client id, not a session key — see TAIL2-PROTOCOL.md §10a for the
 * full decode history, including the aa29 reply frames whose differing
 * session header is the one shape this checksum model does not yet cover).
 */

export const TAIL2_UDP_CONTROL_PORT = 9999;

/** Reflected CRC-16, poly 0xA001, init 0, xorout 0 (the CRC-16/MODBUS core). */
function crc16A001(bytes: readonly number[]): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b & 0xff;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

const swap16 = (v: number): number => (((v & 0xff) << 8) | (v >> 8)) & 0xffff;

/**
 * The TLV value checksum: byteswap16(crc16(subcmd, value)) ^ 0xfe06,
 * big-endian on the wire. Verified against 21 Center captures spanning two
 * different command ids — a pure function of the value bytes. 2026-09-30.
 */
export function tlvValueChecksum(subcmd: number, value: number): number {
  return swap16(crc16A001([subcmd & 0xff, value & 0xff])) ^ 0xfe06;
}

/**
 * The frame checksum (bytes [6..7]): CRC over the frame's FIRST TWENTY
 * BYTES with the field itself zeroed — the tail beyond byte 20 is not
 * covered at all, which is why full-frame sweeps missed it.
 *
 *   be16 = byteswap16(crc16(prefix20)) ^ 0xdbe4   (high byte lands at [6])
 *
 * Cracked from a both-directions idle capture 2026-09-30: one formula, one
 * offset, across polls, writes, and ~900-byte telemetry pushes in both
 * directions; then verified byte-exact against both captured hybrid-zoom
 * frames and hardware-accepted with a fresh random sequence.
 */
export function frameChecksum(prefix20: readonly number[]): number {
  if (prefix20.length !== 20) throw new Error("frameChecksum covers exactly bytes [0..19]");
  const zeroed = [...prefix20];
  zeroed[6] = 0;
  zeroed[7] = 0;
  return swap16(crc16A001(zeroed)) ^ 0xdbe4;
}

/** The 20-byte write-frame prefix, checksum slot zeroed, for a given seq. */
function controlPrefix20(seq: number): number[] {
  return [
    0xaa, 0x25, seq & 0xff, (seq >> 8) & 0xff, 0x14, 0x00, 0x00, 0x00,
    0x0c, 0x02, 0x82, 0xc1, 0x02, 0x06, 0xa7, 0x71, 0xdf, 0x1c, 0x03, 0x57,
  ];
}

/** Synthesize a complete 26-byte zoom-family control write. */
export function buildControlFrame(subcmd: number, value: number, seq: number): Buffer {
  const prefix = controlPrefix20(seq);
  const ck = frameChecksum(prefix);
  prefix[6] = (ck >> 8) & 0xff;
  prefix[7] = ck & 0xff;
  const tlv = tlvValueChecksum(subcmd, value);
  return Buffer.from([...prefix, 0x02, 0x00, (tlv >> 8) & 0xff, tlv & 0xff, subcmd & 0xff, value & 0xff]);
}

/**
 * The generic key→value writer, command `0c 04 44 54` (flip-sheet census
 * 2026-10-01, TAIL2-PROTOCOL.md §10b). Tail grammar:
 *
 *   <len LE16> <ck 2B BE> <value: 00 00 00 00 <key LE32> <val>>
 *
 * where `val` is ONE byte for booleans (len 9) or four LE bytes for
 * int32/float32 (len 12). The TLV checksum is the same CRC core as the
 * two-byte form but with a length-dependent constant (no unified init
 * exists — searched exhaustively):
 *
 *   swap16(crc16_0xA001(value)) ^ { 9: 0xe1dd, 12: 0x440a }
 *
 * Verified against all ten golden frames from the labeled capture.
 */
const KV_TLV_XOR: Record<number, number> = { 9: 0xe1dd, 12: 0x440a };

export const KV_KEYS = {
  zoneTracking: 0x03,
  customTrackingEnable: 0x04,
  panAuto: 0x06,
  panSpeed: 0x07,
  tiltAuto: 0x09,
  tiltSpeed: 0x0a,
  autoZoomSpeed: 0x17,
} as const;
// Key 0x06/0x09 semantics hardware-verified 2026-10-01: they flip
// tracking_settings.horizontal_auto/vertical_auto — the Auto buttons,
// NOT the axis locks (whose write path is still unknown; §9).

/** The sender-identity TLV value (`02 06` = type 2, length SIX): our constant. */
const SENDER_ID: readonly number[] = [0xa7, 0x71, 0xdf, 0x1c, 0x03, 0x57];

export function buildKVFrame(
  key: number,
  value: number | boolean,
  seq: number,
  id: readonly number[] = SENDER_ID,
  opts: { bool8?: boolean } = {},
): Buffer {
  // Width is per-key on the wire: the axis-lock bools ride ONE byte (len 9),
  // everything else — booleans included — rides four (len 12).
  const val: number[] =
    typeof value === "boolean"
      ? opts.bool8
        ? [value ? 1 : 0]
        : [value ? 1 : 0, 0, 0, 0]
      : [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
  const valueBytes = [0x00, 0x00, 0x00, 0x00, key & 0xff, (key >> 8) & 0xff, (key >> 16) & 0xff, (key >> 24) & 0xff, ...val];
  const len = valueBytes.length;
  const xor = KV_TLV_XOR[len];
  if (xor === undefined) throw new Error(`no TLV checksum constant for value length ${len}`);
  const ck = swap16(crc16A001(valueBytes)) ^ xor;
  const prefix = [
    0xaa, 0x25, seq & 0xff, (seq >> 8) & 0xff, 0x14, 0x00, 0x00, 0x00,
    0x0c, 0x04, 0x44, 0x54, 0x02, 0x06, ...id,
  ];
  const fck = frameChecksum(prefix);
  prefix[6] = (fck >> 8) & 0xff;
  prefix[7] = fck & 0xff;
  return Buffer.from([...prefix, len & 0xff, (len >> 8) & 0xff, (ck >> 8) & 0xff, ck & 0xff, ...valueBytes]);
}

/** Injectable so tests can pin the sequence; production draws fresh. */
export function randomSeq(): number {
  return Math.floor(Math.random() * 0x10000);
}

/** Injectable so tests can intercept without touching the network. */
export type UdpFrameSender = (host: string, frame: Buffer) => Promise<void>;

/**
 * Fire one control datagram at the camera. Control writes take effect
 * without any ack frame we model — the camera's replies ride its own
 * session socket, and acceptance is behavioral (this mirrors Center, which
 * also never waits). Errors here are local socket failures only.
 */
export async function sendUdpFrame(host: string, frame: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const sock = createSocket("udp4");
    sock.on("error", (e) => {
      sock.close();
      reject(e instanceof Error ? e : new Error(String(e)));
    });
    sock.send(frame, TAIL2_UDP_CONTROL_PORT, host, (err) => {
      if (err) {
        sock.close();
        reject(err);
      } else {
        sock.close();
        resolve();
      }
    });
  });
}

/** Unlock (true) or re-lock (false) the 5-12x digital zoom region. */
export async function hybridZoomSet(
  host: string,
  enabled: boolean,
  send: UdpFrameSender = sendUdpFrame,
  seq: number = randomSeq(),
): Promise<void> {
  await send(host, buildControlFrame(0x01, enabled ? 0x01 : 0x00, seq));
}

/**
 * Write one key→value on the generic 4454 surface. `value` is a boolean,
 * an int32, or a float already encoded as its LE32 integer bits (callers
 * serialize floats — the camera stores e.g. pan 0.4 as float32).
 */
export async function kvSet(
  host: string,
  key: number,
  value: number | boolean,
  send: UdpFrameSender = sendUdpFrame,
  seq: number = randomSeq(),
  opts: { bool8?: boolean } = {},
): Promise<void> {
  await send(host, buildKVFrame(key, value, seq, undefined, opts));
}

/** Serialize a float to its LE-preserved uint32 bit pattern (for kvSet). */
export function f32Bits(x: number): number {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, x, true);
  return new DataView(buf).getUint32(0, true);
}
