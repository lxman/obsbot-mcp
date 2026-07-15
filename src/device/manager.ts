import { DeviceInfo } from "../codec/types.js";
import { HelperProcess } from "../transport/helper-process.js";
import { ObsbotTransport } from "../transport/transport.js";
import { WindowsTransport } from "../transport/windows.js";
import { LinuxTransport } from "../transport/linux.js";

export class DeviceManager {
  constructor(private helper: HelperProcess) {}

  private createTransport(): ObsbotTransport {
    if (process.platform === "linux") {
      return new LinuxTransport(this.helper);
    }
    return new WindowsTransport(this.helper);
  }

  async list(): Promise<DeviceInfo[]> {
    return this.helper.enumerate();
  }

  async openFirstObsbot(): Promise<ObsbotTransport> {
    const devices = await this.list();
    const obsbotDevices = devices.filter((d) => /obsbot/i.test(d.name));
    if (obsbotDevices.length === 0) {
      throw new Error("no OBSBOT Tiny 2 found");
    }
    // The OBSBOT exposes two /dev/videoN nodes: one is the video capture
    // interface (has the vendor XU extension unit), the other is metadata/ISP
    // (no XU). Try each in turn until we find one with an XU unit.
    const errors: string[] = [];
    for (const device of obsbotDevices) {
      try {
        const xuNode = await this.helper.open(device.path);
        if (xuNode >= 0) return this.createTransport();
        errors.push(`${device.path}: no XU unit`);
      } catch (e) {
        errors.push(`${device.path}: ${(e as Error).message}`);
      }
    }
    throw new Error(
      `could not open any OBSBOT device:\n  ${errors.join("\n  ")}`,
    );
  }
}
