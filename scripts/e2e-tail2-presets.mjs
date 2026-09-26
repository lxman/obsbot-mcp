// Live hardware check for the preset tools (runs dist/). Motion-free by
// construction: the slot is saved from the CURRENT pose, so recalling it
// drives the camera to where it already is.
import { Tail2Registry } from "../dist/tail2/registry.js";
import { createTail2Tools } from "../dist/tail2/tools.js";

const reg = new Tail2Registry();
await reg.addHost("192.168.0.132");
const tool = (name) => {
  const t = createTail2Tools(reg).find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

const before = await tool("obsbot_tail2_preset_list").handler({});
console.log("before:", JSON.stringify(before.slots.map((s) => [s.slot, s.occupied])));

const saved = await tool("obsbot_tail2_preset_save").handler({ slot: 2, name: "module-test" });
console.log("save slot2:", JSON.stringify({ ok: saved.ok, settled: saved.settled }));

const recalled = await tool("obsbot_tail2_preset_recall").handler({ slot: 2 });
console.log("recall slot2:", JSON.stringify(recalled));
if (recalled.settled !== true) throw new Error("recall did not verify on live hardware");

const renamed = await tool("obsbot_tail2_preset_rename").handler({ slot: 2, name: "renamed" });
console.log("rename slot2:", JSON.stringify({ ok: renamed.ok, settled: renamed.settled }));

const after = await tool("obsbot_tail2_preset_list").handler({});
console.log(
  "after rename:",
  JSON.stringify(after.slots.find((s) => s.slot === 2)),
);

const deleted = await tool("obsbot_tail2_preset_delete").handler({ slot: 2 });
console.log("delete slot2:", JSON.stringify(deleted));

const end = await tool("obsbot_tail2_preset_list").handler({});
console.log("end:", JSON.stringify(end.slots.map((s) => [s.slot, s.occupied])));
if (end.slots.find((s) => s.slot === 2)?.occupied) throw new Error("slot 2 not deleted");
if (!end.slots.find((s) => s.slot === 1)?.occupied) throw new Error("factory preset disturbed!");
console.log("PRESET TOOLS LIVE OK");
