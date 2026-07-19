import { HelperProcess } from "./helper-process.js";
import { ObsbotTransport, Snapshot, SnapshotOpts } from "./transport.js";

const VENDOR_XU_SELECTOR = 0x02;
// Intended read-back selector for the (future) per-command V3-frame Get path
// used by recvVendor. This path is UNPROVEN and reads back all zeros.
//
// Hardware sweep 2026-07-19 (Tiny 2, camera awake) — do not re-chase this:
//   - sel 0x02 after a vendor SET: all zeros (the long-standing symptom).
//   - sel 0x06: returns the flat STATUS BLOCK verbatim (starts 0x25, fails
//     parseFrame "bad magic") — it is NOT a per-command reply. Pointing
//     recvVendor at 6 was tried and reverted; it only masked the problem.
//   - sels 1,3,5,9,11,15,16: zeros. The `aa 29` reply frames visible in USB
//     captures are not reachable through this xu_get surface at all.
// Preset/state read-back instead lives on dedicated FLAT selectors (12 = list,
// 13 = entry cursor), like STATUS_SELECTOR below — not via framed replies.
const RESPONSE_SELECTOR = 0x02;
const DEFAULT_REPLY_LEN = 60;
// The camera exposes a flat status block on this XU selector; GET_CUR reads it
// whole (see decodeStatus). Confirmed on the physical Tiny 2 (2026-07-13):
// awake (byte 0x02) and hdr (byte 0x06) round-trip against set_run_status/hdr.
const STATUS_SELECTOR = 0x06;
const STATUS_BLOCK_LEN = 60;

export class WindowsTransport implements ObsbotTransport {
  private seq = 0;

  constructor(private helper: HelperProcess) {}

  async sendVendor(frame: Buffer): Promise<void> {
    await this.helper.xuSet(VENDOR_XU_SELECTOR, frame);
  }

  async recvVendor(frame: Buffer, length = DEFAULT_REPLY_LEN): Promise<Buffer> {
    await this.helper.xuSet(VENDOR_XU_SELECTOR, frame);
    return this.helper.xuGet(RESPONSE_SELECTOR, length);
  }

  async recvStatus(length = STATUS_BLOCK_LEN): Promise<Buffer> {
    return this.helper.xuGet(STATUS_SELECTOR, length);
  }

  async xuRaw(selector: number, data: Buffer): Promise<void> {
    await this.helper.xuSet(selector, data);
  }

  async xuGetRaw(selector: number, length: number): Promise<Buffer> {
    return this.helper.xuGet(selector, length);
  }

  async zoomRange(): Promise<{ min: number; max: number }> {
    return this.helper.zoomRange();
  }

  async zoomSet(units: number): Promise<void> {
    await this.helper.zoomSet(units);
  }

  async snapshot(opts: SnapshotOpts): Promise<Snapshot> {
    return this.helper.snapshot(opts);
  }

  async camCtrlSet(property: number, value: number, flags: number): Promise<void> {
    await this.helper.camCtrlSet(property, value, flags);
  }

  async camCtrlRange(property: number): Promise<{ min: number; max: number }> {
    return this.helper.camCtrlRange(property);
  }

  async camCtrlGet(property: number): Promise<{ value: number; flags: number }> {
    return this.helper.camCtrlGet(property);
  }

  async procAmpSet(property: number, value: number, flags: number): Promise<void> {
    await this.helper.procAmpSet(property, value, flags);
  }

  async procAmpRange(property: number): Promise<{ min: number; max: number }> {
    return this.helper.procAmpRange(property);
  }

  nextSeq(): number {
    this.seq = this.seq >= 0xffff ? 1 : this.seq + 1;
    return this.seq;
  }

  async close(): Promise<void> {
    await this.helper.close();
  }
}
