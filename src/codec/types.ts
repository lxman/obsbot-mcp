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
}
