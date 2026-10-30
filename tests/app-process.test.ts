import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAppPid, parseAppPids, selectActivityPid, verifyAppProcessName } from "../electron/device/app-process";

test("App PID parsing requires one complete positive PID, never the first token", () => {
  assert.equal(parseAppPid(0, "31196\r\n"), 31196);
  for (const output of ["", "0", "-1", "318 31196", "318\n31196", "31196abc", "2147483648", "9999999999999999"]) {
    assert.throws(() => parseAppPid(0, output));
  }
  assert.throws(() => parseAppPid(1, "31196"));
});

test("multiple same-name processes use the foreground Activity owner, not list order", () => {
  const section = "ACTIVITY sample.app/.MainActivity a1b2 pid=31196 userId=0\n  View Hierarchy:";
  assert.equal(selectActivityPid(parseAppPids(0, "318 31196\n"), section), 31196);
  assert.equal(selectActivityPid(parseAppPids(0, "31196 318\n"), section), 31196);
  assert.throws(() => selectActivityPid([318], section));
  assert.throws(() => selectActivityPid([318, 31196], "ACTIVITY sample.app/.MainActivity a1b2 pid=(not running)"));
  for (const raw of ["", "318 318", "318 invalid", "1 2 3 4 5 6 7 8 9"]) assert.throws(() => parseAppPids(0, raw));
});

test("forwarding rejects a wrong process, subprocess, unreadable or missing cmdline", () => {
  verifyAppProcessName(0, Buffer.from("sample.app\0\0\0"), "sample.app");
  // A truncated PID can be syntactically valid: process name must still be checked.
  for (const name of ["system_server\0", "other.app\0", "sample.app:worker\0", "sample.app.extra\0", ""]) {
    assert.throws(() => verifyAppProcessName(0, Buffer.from(name), "sample.app"));
  }
  assert.throws(() => verifyAppProcessName(1, Buffer.from("sample.app\0"), "sample.app"));
  assert.throws(() => verifyAppProcessName(0, Buffer.alloc(4097), "sample.app"));
});
