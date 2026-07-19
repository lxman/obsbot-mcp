import { expect, test, vi } from "vitest";
import { hexToBuf, bufToHex } from "../../src/codec/encoding.js";
import { WindowsTransport } from "../../src/transport/windows.js";
import { LinuxTransport } from "../../src/transport/linux.js";
import { MacosTransport } from "../../src/transport/macos.js";
import type { HelperProcess } from "../../src/transport/helper-process.js";

// Captured GET_CUR reply (selector 6) to a status query, aa29 frame, non-zero.
// Padded out to the 60-byte (120 hex char) default reply length.
const REPLY = "aa2907000c0067160a04043b0100e63f000d000600000000".padEnd(120, "0");

function makeFakeHelper() {
  return {
    xuSet: vi.fn(async (_selector: number, _data: Buffer) => {}),
    xuGet: vi.fn(async (_selector: number, _length: number) => hexToBuf(REPLY)),
  } as unknown as HelperProcess;
}

const transports = [
  { name: "WindowsTransport", Ctor: WindowsTransport },
  { name: "LinuxTransport", Ctor: LinuxTransport },
  { name: "MacosTransport", Ctor: MacosTransport },
] as const;

for (const { name, Ctor } of transports) {
  test(`${name}.recvVendor reads the reply via selector 6, not 0x02`, async () => {
    const helper = makeFakeHelper();
    const t = new Ctor(helper);
    const req = hexToBuf("aa2501");

    const out = await t.recvVendor(req, 60);

    // Send still goes out on the vendor selector (2).
    expect(helper.xuSet).toHaveBeenCalledWith(2, req);
    // But the reply must be read back on selector 6 — the same selector the
    // working status-block read uses — not the broken 0x02 GET path.
    expect(helper.xuGet).toHaveBeenCalledWith(6, 60);

    // The decoded reply is the non-zero captured payload, proving the read
    // actually happened against the (stubbed) selector-6 path.
    expect(bufToHex(out)).toBe(REPLY);
    expect(bufToHex(out)).not.toMatch(/^0+$/);
  });
}
