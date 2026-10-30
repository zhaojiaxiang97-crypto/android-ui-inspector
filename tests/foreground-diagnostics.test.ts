import assert from "node:assert/strict";
import { test } from "node:test";
import { checkedForegroundTarget, ForegroundUnavailableError, foregroundTarget } from "../electron/device/target";

const packageName = "com.example.foreground";
const valid = `topResumedActivity=ActivityRecord{abc123 u0 ${packageName}/.Main t1}`;
const result = (stdout: string, code: number | null = 0, stderr = "") => ({ stdout: Buffer.from(stdout), code, stderr });

test("foreground command failures, empty fields, malformed targets and foreign apps have fixed diagnostics", () => {
  const cases = [
    [result(valid, 1, "private-command-output"), "query-failed"],
    [result(valid, null), "query-failed"],
    [result("private-output-without-resumed-field"), "missing-field"],
    [result("mResumedActivity: null"), "null-foreground"],
    [result("topResumedActivity=null\nmResumedActivity: null"), "null-foreground"],
    [result("topResumedActivity=private-malformed-value"), "unrecognized-format"],
    [result("topResumedActivity=null\nmResumedActivity: private-malformed-value"), "unrecognized-format"],
    [result(valid.replace(packageName, "invalid-package")), "invalid-package"],
    [result(valid.replace(packageName, "com.private.foreign")), "outside-grant"],
  ] as const;
  for (const [command, reason] of cases) {
    assert.throws(() => checkedForegroundTarget(command, packageName), error => {
      assert(error instanceof ForegroundUnavailableError); assert.equal(error.foregroundReason, reason);
      assert(!/private|ActivityRecord|abc123/.test(error.message));
      assert.equal(Object.keys(error).sort().join(","), "foregroundReason,name");
      return true;
    });
  }
});

test("zero-exit dumpsys permission, service and timeout failures cannot masquerade as valid targets", () => {
  for (const text of ["Permission Denial", "Permission denied", "SecurityException", "Can't find service: activity", "Error dumping service info:", "DUMP TIMEOUT"]) {
    for (const command of [result(valid + "\n" + text), result(valid, 0, text)])
      assert.throws(() => checkedForegroundTarget(command, packageName), error => error instanceof ForegroundUnavailableError && error.foregroundReason === "query-failed");
  }
});

test("accepted foreground parsing and Activity identity stay compatible", () => {
  for (const text of [valid, valid.replace("topResumedActivity=", "mResumedActivity: "), "mResumedActivity: null\n" + valid]) {
    assert.deepEqual(checkedForegroundTarget(result(text), packageName), foregroundTarget(text));
    assert.equal(checkedForegroundTarget(result(text)).activityRecordId, "abc123");
  }
});
