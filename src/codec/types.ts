export type RunState = "run" | "sleep";
export interface VendorFrame {
  kind: "vendor";
  buildFrame: (seq: number) => Buffer;
}
export interface ZoomUnits {
  kind: "zoom";
  units: number;
}
export interface DeviceInfo {
  path: string;
  name: string;
  locationId?: number; // macOS: USB locationID; the handle used to correlate + open. NOT identity.
  serial?: string;     // read on demand via UG_GET_SN; the stable per-unit identity.
  vid?: number;        // USB vendor ID (Remo = 0x3564), when the helper reports it. Hardware identity.
  pid?: number;        // USB product ID (Tiny 2 = 0xFEF8), when the helper reports it. Selects the model.
}
