/** CRC-16/USB: poly 0xA001 (reflected), init 0xFFFF, refin/refout, xorout 0xFFFF. */
export const crc16usb = (data: Buffer): number => {
  let crc = 0xffff;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return (crc ^ 0xffff) & 0xffff;
};
