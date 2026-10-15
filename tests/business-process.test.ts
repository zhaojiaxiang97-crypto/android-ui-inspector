import assert from "node:assert/strict";
import { test } from "node:test";
import { businessSettingsPid } from "../scripts/business-process";

test("business probes resolve the settings owner and verify its process name", () => {
  const mock = (pids = "8934 6884", owner = "6884", name = "sample.app\0") => (...args: string[]) => {
    if (args.includes("pidof")) return pids;
    if (args.includes("dumpsys")) return `  ACTIVITY sample.app/.Home a1 pid=8934\n  ACTIVITY sample.app/com.yxcorp.plugin.setting.activity.SettingsActivity a2 pid=${owner}\n`;
    assert.ok(args.includes(`/proc/${owner}/cmdline`));
    return name;
  };
  assert.equal(businessSettingsPid(mock(), "sample.app"), "6884");
  assert.equal(businessSettingsPid(mock("6884 8934"), "sample.app"), "6884");
  assert.throws(() => businessSettingsPid(mock("8934"), "sample.app"));
  assert.throws(() => businessSettingsPid(mock(undefined, undefined, "other.app\0"), "sample.app"));
  assert.throws(() => businessSettingsPid(() => "6884", "sample.app"));
});
