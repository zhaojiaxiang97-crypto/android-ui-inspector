import assert from "node:assert/strict";
import { test } from "node:test";
import { observeQueueMainProcess, verifyInstalledQueueApk, verifyQueueProcess } from "../scripts/diagnostics/sdk/sdk-queue-identity";
const target = { serial: "fixture", packageName: "example.app", pid: 42, startTicks: "12345" };
const sha = "a".repeat(64), path = "/data/app/~~fixture/example.app-ab/base.apk";
const stat = (ticks = "12345") => {
  const fields = Array(25).fill("0"); fields[0] = "S"; fields[19] = ticks;
  return Buffer.from(`42 (name (with) spaces) ${fields.join(" ")}`);
};
const signal = () => new AbortController().signal;
const frame = (before = stat(), name = "example.app\0\0", after = before) =>
  Buffer.concat([before, Buffer.from("\n" + name), after, Buffer.from("\n")]);
test("installed APK verification hashes exact path then rechecks path, without launch/install", async () => {
  const calls: string[][] = [];
  const result = await verifyInstalledQueueApk(target, sha, signal(), async (args, timeout) => {
    calls.push(args); assert.ok(timeout <= 5000);
    return Buffer.from(args.includes("sha256sum") ? `${sha}  ${path}\n` : `package:${path}\n`);
  });
  assert.deepEqual(result, { apkSha256: sha, installedPath: path });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1], ["-s", "fixture", "shell", "sha256sum", path]);
});
test("wrong hash, replaced path, split APKs and unsafe path are rejected", async () => {
  await assert.rejects(verifyInstalledQueueApk(target, sha, signal(), async args =>
    Buffer.from(args.includes("sha256sum") ? `${"b".repeat(64)}  ${path}` : `package:${path}`)), /digest mismatch/);
  let calls = 0;
  await assert.rejects(verifyInstalledQueueApk(target, sha, signal(), async args => {
    calls++;
    return Buffer.from(args.includes("sha256sum") ? `${sha}  ${path}` : `package:${calls === 3 ? path.replace("ab", "cd") : path}`);
  }), /replaced/);
  for (const output of [`package:${path}\npackage:${path.replace("base", "split")}`, "package:/data/app/../base.apk", "bad reply"]) {
    await assert.rejects(verifyInstalledQueueApk(target, sha, signal(), async () => Buffer.from(output)), /path unavailable/);
  }
});
test("one bounded Debug system read brackets cmdline with actual start identities", async () => {
  const calls: string[][] = [];
  assert.deepEqual(await verifyQueueProcess(target, signal(), async (args, timeout) => {
    calls.push(args);
    assert.equal(timeout, 250); return frame();
  }), { pid: 42, startTicks: "12345" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["-s", "fixture", "exec-out", "run-as", "example.app", "cat", "/proc/42/stat", "/proc/42/cmdline", "/proc/42/stat"]);
});
test("foreign process, PID reuse and changed start ticks cannot validate", async () => {
  await assert.rejects(verifyQueueProcess(target, signal(), async () => frame(stat(), "example.app:helper\0")), /不属于/);
  for (const output of [frame(stat("12346")), frame(stat(), "example.app\0", stat("12346")),
    frame(Buffer.from("99 (other) S 0")), frame(stat(), "example.app\0", Buffer.from("99 (other) S 0"))])
    await assert.rejects(verifyQueueProcess(target, signal(), async () => output), /identity changed/);
});
test("truncated, ambiguous, extra argument and oversized process replies fail closed", async () => {
  const normal = frame();
  for (const output of [stat(), normal.subarray(0, -1), frame(stat(), "example.app"),
    frame(stat(), "example.app\0extra\0"), Buffer.concat([normal, stat(), Buffer.from("\n")]),
    frame(stat(), "example.app\0", Buffer.concat([stat(), Buffer.from("\0")])), Buffer.alloc(8193)]) {
    let calls = 0;
    await assert.rejects(verifyQueueProcess(target, signal(), async () => { calls++; return output; }));
    assert.equal(calls, 1, "no parsing fallback or retry");
  }
});
test("transport failure, cancellation and invalid inputs send no follow-up", async () => {
  let calls = 0;
  const controller = new AbortController();
  await assert.rejects(verifyQueueProcess(target, controller.signal, async () => {
    calls++; controller.abort(Error("cancelled")); return stat();
  }), /cancelled/);
  assert.equal(calls, 1);
  await assert.rejects(verifyInstalledQueueApk(target, sha, signal(), async () => { throw Error("unavailable"); }), /unavailable/);
  const execute = async () => { calls++; return stat(); };
  await assert.rejects(verifyQueueProcess({ ...target, pid: -1 }, signal(), execute), /Invalid/);
  await assert.rejects(verifyQueueProcess({ ...target, serial: "bad; command" }, signal(), execute), /Invalid/);
  await assert.rejects(verifyInstalledQueueApk(target, "unknown", signal(), execute), /digest required/);
  assert.equal(calls, 1);
});

test("main process discovery observes temporary absence, then pins real stat/cmdline without SDK/UI calls", async () => {
  let time = 0;
  const calls: string[][] = [];
  const result = await observeQueueMainProcess(target, signal(), {
    now: () => time, wait: async ms => { time += ms; },
    execute: async (args, timeout) => {
      calls.push(args); assert.ok(timeout > 0 && timeout <= 250);
      if (!args.includes("pidof")) return frame();
      if (calls.length === 1) throw Object.assign(Error("pidof absent"), { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
      return Buffer.from(calls.length === 2 ? "" : "42\n");
    },
  });
  assert.deepEqual(result, { pid: 42, startTicks: "12345", pidReads: 3, elapsedMs: 200 });
  assert.equal(calls.length, 4);
  assert.ok(calls.every(args => args.includes("pidof") || args.includes("run-as")));
  assert.deepEqual(calls.at(-1), ["-s", "fixture", "exec-out", "run-as", "example.app", "cat", "/proc/42/stat", "/proc/42/cmdline", "/proc/42/stat"]);
});

test("main discovery has fixed time/read bounds; timed-out/late reads cannot start a diagnostic", async () => {
  let time = 0, calls = 0;
  await assert.rejects(observeQueueMainProcess(target, signal(), { now: () => time,
    wait: async ms => { time += ms; }, execute: async () => { calls++; return Buffer.alloc(0); } }), /not observed/);
  assert.equal(calls, 10); assert.equal(time, 900);
  calls = 0; time = 0;
  await assert.rejects(observeQueueMainProcess(target, signal(), { now: () => time, execute: async () => {
    calls++; time = 1000; return Buffer.from("42");
  } }), /deadline/);
  assert.equal(calls, 1);
  calls = 0; time = 0;
  await assert.rejects(observeQueueMainProcess(target, signal(), { now: () => time, execute: async args => {
    calls++; if (args.includes("pidof")) { time = 900; return Buffer.from("42"); }
    time = 1001; return frame();
  } }), /deadline/);
  assert.equal(calls, 2);
});

test("main discovery refuses ambiguity, foreign/changed processes and real transport errors without retry", async () => {
  for (const pid of ["0", "42 43", "42\n43", "42; start", "9007199254740992"]) {
    let calls = 0;
    await assert.rejects(observeQueueMainProcess(target, signal(), { execute: async () => { calls++; return Buffer.from(pid); } }), /ambiguous/);
    assert.equal(calls, 1);
  }
  for (const result of [frame(stat(), "example.app:helper\0"), frame(stat(), "example.app\0", stat("12346")), frame().subarray(0, -1)]) {
    let calls = 0;
    await assert.rejects(observeQueueMainProcess(target, signal(), { execute: async args => { calls++; return args.includes("pidof") ? Buffer.from("42") : result; } }));
    assert.equal(calls, 2);
  }
  for (const error of [Error("timeout"), Object.assign(Error("permission"), { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("denied") }),
    Object.assign(Error("bad pid"), { code: 1, stdout: Buffer.from("42"), stderr: Buffer.alloc(0) }), Object.assign(Error("unavailable"), { code: 1 })]) {
    let calls = 0;
    await assert.rejects(observeQueueMainProcess(target, signal(), { execute: async () => { calls++; throw error; } }));
    assert.equal(calls, 1);
  }
});

test("main discovery cancellation and invalid input do not continue or accept late PID replies", async () => {
  let calls = 0;
  const execute = async () => { calls++; return Buffer.from("42"); };
  await assert.rejects(observeQueueMainProcess({ ...target, serial: "bad; serial" }, signal(), { execute }), /Invalid/);
  const pre = new AbortController(); pre.abort(Error("pre-cancel"));
  await assert.rejects(observeQueueMainProcess(target, pre.signal, { execute }), /pre-cancel/);
  assert.equal(calls, 0);
  for (const phase of ["pid", "wait", "stat"] as const) {
    calls = 0; const controller = new AbortController();
    await assert.rejects(observeQueueMainProcess(target, controller.signal, {
      execute: async args => {
        calls++;
        if (args.includes("pidof")) { if (phase === "pid") controller.abort(Error(phase)); return Buffer.from(phase === "wait" ? "" : "42"); }
        controller.abort(Error(phase)); return frame();
      }, wait: async () => { controller.abort(Error(phase)); },
    }), new RegExp(phase));
    assert.equal(calls, phase === "stat" ? 2 : 1);
  }
});
