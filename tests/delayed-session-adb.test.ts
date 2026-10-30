import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("isolated ADB relay drains binary output and maps only SDK forwards", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-relay-test-"));
  const journal = join(directory, "forwards.jsonl");
  const mock = join(import.meta.dirname, "fixtures/relay-output-adb");
  chmodSync(mock, 0o755); writeFileSync(journal, "");
  const call = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, "../scripts/lib/delayed-session-adb"), ...args], {
    env: { ...process.env, INSPECTOR_PROBE_REAL_ADB: mock, INSPECTOR_PROBE_FORWARD_LOG: journal, INSPECTOR_PROBE_PROXY_PORT: "12345" },
    timeout: 10000, maxBuffer: 1024 * 1024,
  });
  try {
    const dump = call("shell", "dump");
    assert.equal(dump.status, 0); assert.equal(dump.stdout.length, 400000);
    assert.equal([...dump.stdout].every((value, i) => value === i % 256), true);
    assert.equal(call("forward", "tcp:0", "jdwp:123").stdout.toString(), "23456\n");
    assert.equal(readFileSync(journal, "utf8"), "");
    assert.equal(call("forward", "tcp:0", "localabstract:com.example.inspector.session").stdout.toString(), "12345\n");
    assert.equal(call("forward", "--remove", "tcp:12345").status, 0);
    const entries = readFileSync(journal, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(entries, [{ type: "open", port: 23456 }, { type: "remove", port: 23456 }]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
