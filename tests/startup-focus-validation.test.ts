import assert from "node:assert/strict";
import { test } from "node:test";
import { startupDumpEvidence, startupDumpTarget } from "../scripts/diagnostics/startup/startup-focus-validation";

const component = "com.example.test/.MainActivity";
const activities = `topResumedActivity=ActivityRecord{b22 u0 ${component} t2}`;
const target = startupDumpTarget(activities, component, "42\n");
test("startup dump requires exact foreground instance and unique running PID", () => {
  assert.equal(target.activityRecordId, "b22");
  assert.equal(target.pid, 42);
  for (const [state, pid] of [["no foreground", "42"], [activities.replace("b22", "unknown"), "42"],
    [activities.replace(".MainActivity", ".OtherActivity"), "42"], [activities, ""], [activities, "42 43"]]) {
    assert.throws(() => startupDumpTarget(state, component, pid));
  }
});
test("startup evidence rejects stopped, old, duplicate and different-process donors", () => {
  for (const header of [`b22 pid=(not running)`, "a11 pid=42", "b22 pid=43", "b22 pid=42\nACTIVITY " + component + " b22 pid=42"]) {
    assert.throws(() => startupDumpEvidence(`ACTIVITY ${component} ${header}\nView Hierarchy:`, target));
  }
});
test("startup evidence distinguishes live dump timeout from valid hierarchy", () => {
  const header = `ACTIVITY ${component} b22 pid=42\n`;
  assert.deepEqual(startupDumpEvidence(header + "Failure while dumping the activity: java.io.IOException: Timeout", target),
    { runningActivity: true, validHierarchy: false, systemDumpTimeout: true });
  assert.deepEqual(startupDumpEvidence(header + "No tree", target),
    { runningActivity: true, validHierarchy: false, systemDumpTimeout: false });
  assert.deepEqual(startupDumpEvidence(header + "    View Hierarchy:\n      android.view.View{abc V.E...... ........ 0,0-100,100}\n    Looper", target),
    { runningActivity: true, validHierarchy: true, systemDumpTimeout: false });
});
