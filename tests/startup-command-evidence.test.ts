import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { recordStartupCommand, type StartupCommandEvidence } from "../scripts/diagnostics/startup/startup-command-evidence";

test("startup evidence preserves original output, command and timing with one execution", () => {
  const records: StartupCommandEvidence[] = [];
  const command = ["adb", "-s", "fixture", "shell", "am", "start", "-n", "com.example/.MainActivity"];
  let calls = 0;
  const output = Buffer.from("Starting: Intent { cmp=com.example/.MainActivity }\n");
  assert.equal(recordStartupCommand(command, () => { calls++; return output; }, r => records.push(r)), output);
  command.push("changed");
  assert.equal(calls, 1); assert.equal(records.length, 1);
  const r = records[0]; assert.equal(r.stdout, output.toString()); assert.equal(r.status, "completed");
  assert.equal(r.exitCode, 0); assert.equal(r.signal, null); assert.equal(r.errorCode, null);
  assert(!r.command.includes("changed")); assert(r.durationMs >= 0);
  assert(Number.isFinite(Date.parse(r.startedAt))); assert(Date.parse(r.endedAt) >= Date.parse(r.startedAt));
});

test("failed launch saves stdout/stderr and original error before rethrow, without retry", () => {
  const records: StartupCommandEvidence[] = [];
  const error = Object.assign(new Error("failed"), { stdout: Buffer.from("Starting\n"), stderr: Buffer.from("Error: denied\n"), status: 7, signal: null });
  let calls = 0;
  assert.throws(() => recordStartupCommand(["fixture"], () => { calls++; throw error; }, r => records.push(r)), e => e === error);
  assert.equal(calls, 1); assert.equal(records[0].status, "failed"); assert.equal(records[0].exitCode, 7);
  assert.equal(records[0].stdout, "Starting\n"); assert.equal(records[0].stderr, "Error: denied\n");
});

test("actual bounded child timeout retains partial output without inventing an exit code", () => {
  const records: StartupCommandEvidence[] = [];
  assert.throws(() => recordStartupCommand([process.execPath, "fixture"],
    () => execFileSync(process.execPath, ["-e", 'process.stdout.write("partial\\n"); setInterval(()=>{},1000)'], { timeout: 500 }),
    r => records.push(r)));
  assert.equal(records.length, 1); assert.equal(records[0].errorCode, "ETIMEDOUT");
  assert.equal(records[0].exitCode, null); assert.equal(records[0].signal, "SIGTERM");
  assert.equal(records[0].stdout, "partial\n");
});

test("successful host exit is not interpreted as window readiness or capture success", () => {
  let record: StartupCommandEvidence | undefined;
  recordStartupCommand(["fixture"], () => Buffer.from("Error type 3: Activity does not exist\n"), r => { record = r; });
  assert.equal(record!.status, "completed"); assert.match(record!.stdout, /Error type 3/);
  assert(!("processId" in record!)); assert(!("windowReady" in record!));
});

test("successful command preserves stderr warnings too", () => {
  const records: StartupCommandEvidence[] = [];
  recordStartupCommand(["fixture"], () => ({ stdout: Buffer.from("Starting\n"), stderr: Buffer.from("Warning: delayed\n") }), r => records.push(r));
  assert.equal(records[0].stdout, "Starting\n"); assert.equal(records[0].stderr, "Warning: delayed\n");
  assert.equal(records[0].exitCode, 0);
});
