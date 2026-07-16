import { DeviceInfo } from "../codec/types.js";
import { HelperProcess } from "../transport/helper-process.js";
import { ObsbotTransport } from "../transport/transport.js";
import { WindowsTransport } from "../transport/windows.js";
import { MacosTransport } from "../transport/macos.js";

function createTransport(helper: HelperProcess): ObsbotTransport {
  if (process.platform === "darwin") {
    return new MacosTransport(helper);
  }
  return new WindowsTransport(helper);
}

export class DeviceManager {
  constructor(private helper: HelperProcess) {}

  async list(): Promise<DeviceInfo[]> {
    return this.helper.enumerate();
  }

  async openFirstObsbot(): Promise<ObsbotTransport> {
    const devices = await this.list();
    const device = devices.find((d) => /obsbot/i.test(d.name));
    if (!device) {
      throw new Error("no OBSBOT Tiny 2 found");
    }
    await this.helper.open(device.path);
    return createTransport(this.helper);
  }
}
