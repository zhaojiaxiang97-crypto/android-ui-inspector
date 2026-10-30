import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCommandRunner } from "../electron/platform/command-runner";
import { createStartupLogReader, startupLogFileScript, startupLogLimits, type StartupLogInput } from "../scripts/diagnostics/startup/startup-log-reader";

const fixture = fileURLToPath(new URL("./fixtures/startup-log-child.cjs", import.meta.url));
const input = (): StartupLogInput => ({ serial: "fixture", packageName: "example.app", apkSha256: "a".repeat(64),
  pid: 42, startTicks: "12345", files: ["files/startup.log"], allowExistingLogRead: true,
  historicalClock: { sourceRunId: "22222222-2222-2222-2222-222222222222", bootId: "11111111-1111-1111-1111-111111111111",
    epochSeconds: 1050, uptimeSeconds: 50 } });
async function setup(mode = "normal", now?: () => number) {
  const dir = await mkdtemp(join(tmpdir(), "startup-log-fixture-")), state = join(dir, "state.json");
  await writeFile(state, JSON.stringify({ calls: [] }));
  return { dir, runner: createCommandRunner(process.execPath, [fixture, state, mode], now),
    calls: async (): Promise<string[][]> => JSON.parse(await readFile(state, "utf8")).calls,
    close: () => rm(dir, { recursive: true, force: true }) };
}
const signal = () => new AbortController().signal;

test("exec-out receives raw script argv, not a manually shell-quoted script", async () => {
  const f = await setup();
  try {
    const report = await createStartupLogReader(input(), f.runner).run(signal());
    assert.equal(report.status, "collected");
    const calls = await f.calls();
    assert.equal(calls[4][5], "cat /proc/sys/kernel/random/boot_id && date +%s && cat /proc/uptime");
    assert.equal(calls[5][7], startupLogFileScript);
  } finally { await f.close(); }
});

test("local exec-out escaping model preserves syntax/positional arguments; double quoting fails", async () => {
  // AOSP client/commandline.cpp: first command is raw, subsequent argv use escape_arg.
  // Local sh only; this verifies transport quoting, NOT Android utilities or a device.
  const escapeArg = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const remoteCommand = (args: string[]) => args[0] + args.slice(1).map(arg => " " + escapeArg(arg)).join("");
  const script = 'printf \'%s\\n\' "literal\'quote" "$1" "$2" && printf \'done\\n\'';
  const args = ["sh", "-c", script, "fixture", "trace-2031.04:00.log", "literal $(not-a-command)"];
  const result = await promisify(execFile)("/bin/sh", ["-c", remoteCommand(args)], { timeout: 1000, maxBuffer: 4096 });
  assert.equal(result.stdout, "literal'quote\ntrace-2031.04:00.log\nliteral $(not-a-command)\ndone\n");
  assert.equal(result.stderr, "");
  await assert.rejects(promisify(execFile)("/bin/sh", ["-c", remoteCommand(["sh", "-c", escapeArg(script)])],
    { timeout: 1000, maxBuffer: 4096 }), (error: any) => error.code === 127 && error.stdout === "");
});

test("remote errors in exec-out stdout fail validation even when host exit is zero", async () => {
  for (const [mode, count] of [["remote-clock-error", 5], ["remote-file-error", 6]] as const) {
    const f = await setup(mode);
    try {
      const report = await createStartupLogReader(input(), f.runner).run(signal());
      assert.equal(report.status, "stopped"); assert.equal(report.reason, "invalid-reply");
      assert.equal(report.association, "unknown"); assert.equal(report.files.length, 0);
      assert.equal(report.cleanupConfirmed, true); assert.equal(report.commands.length, count);
      assert.equal(report.commands.at(-1)!.exitCode, 0);
      assert.equal(report.commands.at(-1)!.stderr, "");
      assert.match(report.commands.at(-1)!.stdout, /inaccessible/);
    } finally { await f.close(); }
  }
});

test("construction is inert; invalid targets/whitelists/anchors never dispatch", async () => {
  const f = await setup();
  try {
    for (const patch of [{ allowExistingLogRead: false }, { files: [] }, { files: ["../secret"] },
      { files: ["/data/secret"] }, { files: ["files/*.log"] }, { files: ["files/a;id"] },
      { files: ["files/a\0"] }, { files: ["files/.a"] }, { files: ["files/a", "files/a"] },
      { files: ["files/trace:00$(id).log"] }, { files: ["files/trace:00`id`.log"] },
      { files: ["a", "b", "c", "d"] }, { serial: "x;id" }, { packageName: "x;id" },
      { apkSha256: "unknown" }, { pid: 0 }, { startTicks: "bad" }, { historicalClock: undefined },
      { historicalClock: { ...input().historicalClock!, epochSeconds: NaN } }])
      assert.throws(() => createStartupLogReader({ ...input(), ...patch } as StartupLogInput, f.runner));
    createStartupLogReader(input(), f.runner);
    assert.deepEqual(await f.calls(), []); assert.deepEqual(f.runner.snapshot(), []);
  } finally { await f.close(); }
});

test("missing historical clock and pre-cancel stop before commands; no current-state backfill", async () => {
  for (const cancelled of [false, true]) {
    const f = await setup();
    try {
      const controller = new AbortController(); if (cancelled) controller.abort();
      const report = await createStartupLogReader({ ...input(), historicalClock: null }, f.runner).run(controller.signal);
      assert.equal(report.reason, cancelled ? "cancelled" : "clock-unassociated");
      assert.equal(report.cleanupConfirmed, true); assert.equal(report.association, "unknown");
      assert.deepEqual(await f.calls(), []); assert.deepEqual(report.files, []);
    } finally { await f.close(); }
  }
});

test("exact Android timestamp filenames allow colons without broadening shell/path access", async () => {
  const f = await setup();
  try {
    const path = "files/trace-2031-02-03.04:00.log";
    const report = await createStartupLogReader({ ...input(), files: [path] }, f.runner).run(signal());
    assert.equal(report.status, "collected"); assert.equal(report.files[0].path, path);
    const reads = (await f.calls()).filter(args => args[8] === "log-read");
    assert.equal(reads.length, 1); assert.equal(reads[0][9], path);
    assert.equal(reads[0].includes("files/*.log"), false);
    for (const unsafe of ["files/a:00/../secret", "files/a:00;id", "files/a:00\nid", "files/a:00\"id", "files/a:00'id"])
      assert.throws(() => createStartupLogReader({ ...input(), files: [unsafe] }, createCommandRunner(process.execPath)));
  } finally { await f.close(); }
});

test("one pinned round reads exact files with before/after identity and independent raw buffer", async () => {
  const f = await setup("long");
  try {
    const original = input(), reader = createStartupLogReader(original, f.runner);
    original.files[0] = "files/secret"; original.historicalClock!.epochSeconds = 1;
    const report = await reader.run(signal());
    assert.equal(report.status, "collected"); assert.equal(report.cleanupConfirmed, true);
    assert.equal(report.association, "caller-anchor-checked"); assert.equal(report.eventAnalysis, "not-performed");
    assert.equal(report.files[0].path, "files/startup.log"); assert.equal(report.files[0].bytes, 5001);
    assert.equal(report.files[0].content.length, 5001); assert.match(report.files[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(report.commands[5].stdoutTruncated, true, "4KiB command prefix is NOT raw file truncation");
    const calls = await f.calls(); assert.equal(calls.length, 11);
    assert.ok(calls.every(args => !args.some(arg => ["am", "forward", "install", "logcat", "clear", "kill-server"].includes(arg))));
    assert.equal(calls[5][9], "files/startup.log");
    assert.ok(report.commands.every(command => command.closed && command.exitCode === 0));
    report.commands[0].stdout = "changed"; assert.notEqual(f.runner.snapshot()[0].stdout, "changed");
    await assert.rejects(reader.run(signal()), /already used/);
  } finally { await f.close(); }
});

test("boot/time mismatch, malformed clock and reused PID stop before raw logs", async () => {
  for (const mode of ["boot-change", "clock-change", "invalid-clock", "pid-reuse"]) {
    const f = await setup(mode);
    try {
      const report = await createStartupLogReader(input(), f.runner).run(signal());
      assert.equal(report.status, "stopped"); assert.equal(report.association, "unknown");
      assert.equal(report.reason, mode === "pid-reuse" ? "identity-or-read-failed" : mode === "invalid-clock" ? "invalid-reply" : "clock-changed");
      assert.ok((await f.calls()).length <= 5); assert.equal(report.files.length, 0);
    } finally { await f.close(); }
  }
});

test("installation/process/clock changes AFTER reads invalidate the whole round but keep partial evidence", async () => {
  for (const mode of ["install-change", "process-change", "late-clock-change"]) {
    const f = await setup(mode);
    try {
      const report = await createStartupLogReader(input(), f.runner).run(signal());
      assert.equal(report.status, "stopped"); assert.equal(report.association, "unknown");
      assert.equal(report.files.length, 1); assert.equal(report.cleanupConfirmed, true);
      assert.ok((await f.calls()).length <= 11);
    } finally { await f.close(); }
  }
});

test("rotation, size mismatch, incomplete framing/text, binary, bytes/lines overflow all fail closed", async () => {
  for (const [mode, reason] of [["rotate", "log-incomplete"], ["size-change", "log-incomplete"],
    ["truncated-frame", "invalid-reply"], ["tail", "log-incomplete"], ["binary", "log-incomplete"],
    ["utf8", "log-incomplete"], ["bytes-limit", "log-limit"], ["lines-limit", "log-limit"]]) {
    const f = await setup(mode);
    try {
      const report = await createStartupLogReader(input(), f.runner).run(signal());
      assert.equal(report.reason, reason, mode); assert.equal(report.status, "stopped");
      assert.equal(report.files.length, 0); assert.equal((await f.calls()).length, 6);
    } finally { await f.close(); }
  }
});

test("total bytes/lines cap cannot start unlimited file reads or post-success identity checks", async () => {
  for (const mode of ["total-lines", "total-bytes"]) {
    const f = await setup(mode);
    try {
      const report = await createStartupLogReader({ ...input(), files: ["a", "b", "c"] }, f.runner).run(signal());
      assert.equal(report.reason, "log-limit"); assert.equal(report.status, "stopped");
      assert.equal(report.files.length, 2); assert.equal((await f.calls()).length, mode === "total-bytes" ? 7 : 8);
      assert.ok(report.files.reduce((n, file) => n + file.bytes, 0) <= startupLogLimits.totalBytes);
    } finally { await f.close(); }
  }
});

test("warning/nonzero/cancel never retry or accept partial command stdout", async () => {
  for (const mode of ["warning", "nonzero", "wait"]) {
    const f = await setup(mode), controller = new AbortController();
    const timer = mode === "wait" ? setTimeout(() => controller.abort(), 100) : undefined;
    try {
      const report = await createStartupLogReader(input(), f.runner).run(controller.signal);
      assert.equal(report.reason, mode === "warning" ? "command-warning" : mode === "wait" ? "cancelled" : "identity-or-read-failed");
      assert.equal(report.status, "stopped"); assert.equal(report.files.length, 0);
      assert.equal(report.commands.length, 1); assert.equal(report.cleanupConfirmed, true);
      assert.equal(report.commands[0].closed, true);
    } finally { clearTimeout(timer); await f.close(); }
  }
});

test("remaining monotonic budget is not reset; bad clock and late return stop", async () => {
  const f = await setup("normal");
  let time = 0;
  const runner = { ...f.runner, now: () => time, execute: async (...args: Parameters<typeof f.runner.execute>) => {
    const result = await f.runner.execute(...args); time = 18001; return result;
  } };
  try {
    const report = await createStartupLogReader(input(), runner).run(signal());
    assert.equal(report.reason, "deadline"); assert.equal((await f.calls()).length, 1);
    const bad = await setup("normal", () => NaN);
    try { assert.equal((await createStartupLogReader(input(), bad.runner).run(signal())).reason, "deadline");
      assert.equal((await bad.calls()).length, 0); } finally { await bad.close(); }
  } finally { await f.close(); }
});

test("missing child close and failed cleanup remain unknown", async () => {
  const f = await setup();
  try {
    const fake = { ...f.runner, execute: async () => Buffer.from("package:/data/app/fixture/example.app/base.apk\n") };
    const report = await createStartupLogReader(input(), fake).run(signal());
    assert.equal(report.reason, "command-unconfirmed"); assert.equal(report.files.length, 0);
    const brokenCleanup = { ...f.runner, finish: async () => false };
    const stopped = await createStartupLogReader({ ...input(), historicalClock: null }, brokenCleanup).run(signal());
    assert.equal(stopped.reason, "cleanup-unconfirmed"); assert.equal(stopped.cleanupConfirmed, false);
  } finally { await f.close(); }
});

test("real host shell rejects non-app directory before opening any file (not Android utility proof)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "startup-log-root-"));
  try {
    await assert.rejects(promisify(execFile)("/bin/sh", ["-c", startupLogFileScript, "read", "missing.log", "100", "example.app"],
      { cwd: dir, timeout: 1000, maxBuffer: 4096 }), (error: any) => error.code === 64 && error.stdout === "" && error.stderr === "");
    assert.ok(startupLogFileScript.indexOf('readlink -f "$fd"') < startupLogFileScript.indexOf('head -c'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an unresolved command is cancelled boundedly; late output cannot change the final unknown report", async () => {
  const f = await setup(); let release: (value: Buffer) => void = () => {};
  let dispatched = false;
  const pending = new Promise<Buffer>(resolve => { release = resolve; });
  const runner = { ...f.runner, execute: async () => { dispatched = true; return pending; }, finish: async () => false };
  const controller = new AbortController();
  try {
    const reading = createStartupLogReader(input(), runner).run(controller.signal);
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(dispatched, true); controller.abort();
    const report = await reading;
    assert.equal(report.status, "stopped"); assert.equal(report.reason, "cleanup-unconfirmed");
    assert.equal(report.operationReason, "cancelled", "cleanup failure must not erase original cancellation");
    assert.equal(report.association, "unknown"); assert.equal(report.files.length, 0);
    const saved = JSON.stringify(report);
    release(Buffer.from("late reply")); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(JSON.stringify(report), saved);
  } finally { release(Buffer.alloc(0)); await f.close(); }
});
