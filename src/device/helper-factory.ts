import { DeviceManager } from "./manager.js";
import { HelperProcess } from "../transport/helper-process.js";

/**
 * Build the factory DeviceManager spawns its helpers through, with every
 * helper subscribed to the OS bus events before it is started.
 *
 * Subscribing HERE rather than at a call site is the point: there is no single
 * long-lived helper. The scratch scanner is promoted into the registry when a
 * camera binds and the next scan spawns another, so whichever process happens
 * to be alive when the cable moves has to be the one that reports it. Without
 * this the server learns about an unplug only by failing a call against a dead
 * handle — `obsbot_devices` reports a phantom `bound` entry, serial and all,
 * for a camera sitting on the desk, and the first call after a replug fails by
 * design.
 *
 * `getMgr` is a thunk rather than the manager itself because the manager is
 * constructed WITH this factory and so does not exist yet when the factory is
 * built. It is resolved when an event fires, long after construction.
 *
 * `make` is injectable so this can be tested against a fake helper instead of
 * spawning the real binary. The subscription is the whole feature and it is
 * two lines; left inline in startServer() nothing covered it, and deleting it
 * broke no test.
 */
export function helperFactory(
  getMgr: () => DeviceManager,
  make: () => HelperProcess = () => new HelperProcess(),
): () => Promise<HelperProcess> {
  return async () => {
    const helper = make();
    // Before start(), not after: a camera plugged in during spawn would
    // otherwise emit into nothing and the arrival would simply be lost.
    //
    // The handlers never reject (see DeviceManager), but they ARE async while
    // these listeners are sync — swallow explicitly so a surprise rejection
    // cannot become an unhandled one and kill the process from a stdout line
    // handler, losing every in-flight request because a cable moved.
    helper.onCameraArrived((e) => void getMgr().handleCameraArrived(e).catch(() => {}));
    helper.onCameraDeparted((e) => void getMgr().handleCameraDeparted(e).catch(() => {}));
    await helper.start();
    return helper;
  };
}
