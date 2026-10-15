// Read-only business admission. No app install/restart, image requests, or forwards.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { businessTextAdmission } from "../../business-text-admission";
import { parseProcessLoad } from "./sdk-device-load";
import { businessSettingsPid } from "../../business-process";
const serial = process.argv[2];
assert.ok(serial && /^[\w.-]+$/.test(serial));
const app = "com.smile.gifmaker", text = process.argv[3] ?? "设置";
const directory = join(import.meta.dirname, "../../../.benchmarks/business-admission", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(directory, { recursive: true });
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8", timeout: 15000 });
const assertPage = () => assert.match(adb("shell", "dumpsys", "window"),
  /mCurrentFocus=.*com\.smile\.gifmaker\/com\.yxcorp\.plugin\.setting\.activity\.SettingsActivity/,
  "keep the business settings page foreground; this probe does not navigate");
console.log(`Business admission output: ${directory}`);
try {
  assertPage();
  const pid = businessSettingsPid(adb, app);
  const before = parseProcessLoad(adb("exec-out", "run-as", app, "cat", `/proc/${pid}/stat`), pid);
  assert.match(adb("shell", "content", "call", "--uri", `content://${app}.inspector`, "--method", "capture"), /result=ok/);
  const tree = JSON.parse(adb("exec-out", "run-as", app, "cat", "no_backup/inspector-hierarchy.json"));
  assert.equal(businessSettingsPid(adb, app), pid, "business process changed during admission");
  const after = parseProcessLoad(adb("exec-out", "run-as", app, "cat", `/proc/${pid}/stat`), pid);
  assert.equal(after.startTicks, before.startTicks);
  assertPage();
  const result = { ...businessTextAdmission(tree, text, Number(pid)), startTicks: before.startTicks,
    scope: "SDK tree admission only; no pixel or performance comparison", appUnchanged: true };
  writeFileSync(join(directory, "summary.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.eligible ? 0 : 2;
} catch (error) {
  writeFileSync(join(directory, "failure.json"), JSON.stringify({ error: String(error) }, null, 2));
  throw error;
}
