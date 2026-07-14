export const f32le = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeFloatLE(n, 0); return b; };
export const u16le = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff, 0); return b; };
export const u32le = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
export const i32le = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeInt32LE(n | 0, 0); return b; };
export const hexToBuf = (h: string): Buffer => Buffer.from(h, "hex");
export const bufToHex = (b: Buffer): string => b.toString("hex");
export const concat = (...b: Buffer[]): Buffer => Buffer.concat(b);
