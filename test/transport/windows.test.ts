import { expect, test, vi } from "vitest";
import { WindowsTransport } from "../../src/transport/windows.js";
import type { HelperProcess } from "../../src/transport/helper-process.js";

function makeFakeHelper() {
  return {
    xuSet: vi.fn(async (_selector: number, _data: Buffer) => {}),
    xuGet: vi.fn(async (_selector: number, _length: number) => Buffer.from([0xaa, 0x25])),
  } as unknown as HelperProcess;
}

test("recvVendor sends the request via xuSet on selector 2 then reads via xuGet on selector 6", async () => {
  const helper = makeFakeHelper();
  const t = new WindowsTransport(helper);
  const req = Buffer.from([0xaa, 0x25, 0x01]);

  const reply = await t.recvVendor(req);

  expect(helper.xuSet).toHaveBeenCalledWith(2, req);
  expect(helper.xuGet).toHaveBeenCalledTimes(1);
  // Read happens on the response selector (6) with the default length.
  expect((helper.xuGet as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(6);
  expect(reply[0]).toBe(0xaa);
  // Enforce send-then-read order: xuSet must be called before xuGet.
  expect((helper.xuSet as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
    .toBeLessThan((helper.xuGet as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
});

test("recvVendor honours an explicit reply length", async () => {
  const helper = makeFakeHelper();
  const t = new WindowsTransport(helper);
  await t.recvVendor(Buffer.from([0xaa]), 32);
  expect((helper.xuGet as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(32);
});

test("recvStatus reads the status block via xuGet on selector 6 with no xuSet", async () => {
  const helper = makeFakeHelper();
  const t = new WindowsTransport(helper);
  const block = await t.recvStatus();
  expect(helper.xuSet).not.toHaveBeenCalled();
  expect((helper.xuGet as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(6);
  expect(Buffer.isBuffer(block)).toBe(true);
});
