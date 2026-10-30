import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Socket } from "node:net";
import { createCommandRunner } from "../electron/platform/command-runner";
import { createStartupStackProbe, validateStartupProbeArgs, validateStartupLaunch } from "../scripts/diagnostics/startup/startup-stack-probe";

const childFixture = fileURLToPath(new URL("./fixtures/startup-runner-child.cjs", import.meta.url));
const inputBase = { serial: "fixture", packageName: "example.app", component: "example.app/.Home" };
const apkBytes = Buffer.from("local APK fixture, not an installed Android application");
const sha = createHash("sha256").update(apkBytes).digest("hex");
const permission = { ...inputBase, apkSha256: sha, scope: "one-launch-and-main-stack" as const, acknowledged: true as const };
const int = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const string = (s: string) => Buffer.concat([int(Buffer.byteLength(s)), Buffer.from(s)]);
async function fixture(mode = "normal", ready = true) {
  const directory = await mkdtemp(join(tmpdir(), "startup-probe-test-")), apkPath = join(directory, "trusted.apk"), statePath = join(directory, "state.json");
  await writeFile(apkPath, apkBytes);
  await writeFile(statePath, JSON.stringify({ calls: [], started: false, ready, sha, ticks: "12345",
    path: "/data/app/~~fixture/example.app-ab/base.apk", mapping: null }));
  const input = { ...inputBase, apkPath, apkSha256: sha, outputRoot: directory }, controller = new AbortController();
  let clock = 100, cancelLaunch = false, advanceLaunch = !ready;
  const actual = createCommandRunner(process.execPath, [childFixture, statePath, mode], () => clock);
  const runner: typeof actual = { ...actual, execute: async (...args) => {
    const launch = args[0].includes("am"), timer = launch && cancelLaunch ? setTimeout(() => controller.abort(Error("cancel launch")), 150) : undefined;
    try {
      const result = await actual.execute(...args);
      if (launch && advanceLaunch) clock += 12000;
      return result;
    } finally { clearTimeout(timer); }
  } };
  const entry = () => createStartupStackProbe(input, permission, { runner, wait: async ms => { clock += ms; } });
  return { directory, apkPath, statePath, input, controller, runner, entry, permission,
    cancelLaunch: () => { cancelLaunch = true; }, noAdvance: () => { advanceLaunch = false; },
    setTime: (time: number) => { clock = time; },
    state: async () => JSON.parse(await readFile(statePath, "utf8")),
    saved: async (output: string) => JSON.parse(await readFile(join(output, "report.json"), "utf8")),
    close: async () => { await runner.finish(1000); await rm(directory, { recursive: true, force: true }); },
  };
}

test("argument validation needs both explicit acknowledgements and matching immutable target, without I/O", async () => {
  const args = ["fixture", "example.app", "example.app/.Home", "/trusted/app.apk", sha, "/evidence", "--run", "--allow-launch-and-pause"];
  assert.equal(validateStartupProbeArgs(args).input.apkSha256, sha);
  for (const invalid of [args.slice(0, 7), [...args.slice(0, 6), "--allow-launch-and-pause", "--run"],
    ["x;bad", ...args.slice(1)], [...args.slice(0, 3), "relative.apk", ...args.slice(4)]]) assert.throws(() => validateStartupProbeArgs(invalid));
  const r = createCommandRunner(process.execPath);
  const input = { ...inputBase, apkPath: "/abs/app.apk", apkSha256: sha, outputRoot: "/abs/evidence" };
  for (const patch of [{ serial: "foreign" }, { apkSha256: "b".repeat(64) }, { scope: "read-only" }, { acknowledged: false }])
    assert.throws(() => createStartupStackProbe(input, { ...permission, ...patch } as typeof permission, { runner: r }));
  assert.deepEqual(r.snapshot(), []);
});

test("actual CLI refuses missing authorization flags before any device command", async () => {
  const r = createCommandRunner(process.execPath, [fileURLToPath(new URL("../scripts/diagnostics/startup/startup-stack-probe.ts", import.meta.url))]);
  await assert.rejects(r.execute([], 2000, new AbortController().signal));
  const record = r.snapshot()[0]; assert.equal(record.closed, true); assert.notEqual(record.exitCode, 0);
  assert.match(record.stderr, /allow-launch-and-pause/);
});

test("exit0 start errors, warnings and foreign/unknown intents are not accepted as successful launches", () => {
  validateStartupLaunch(Buffer.from("Starting: Intent { cmp=example.app/.Home }\n"), "", inputBase.component);
  validateStartupLaunch(Buffer.from("Starting: Intent { cmp=example.app/example.app.Home }\n"), "", inputBase.component);
  for (const [stdout, stderr] of [["Starting: Intent { cmp=example.app/.Home }", "Error: denied"],
    ["Starting: Intent { cmp=example.app/.Home }", "Warning: task reused"], ["Error type 3", ""],
    ["Starting: Intent { cmp=other.app/.Home }", ""]]) assert.throws(() => validateStartupLaunch(Buffer.from(stdout), stderr, inputBase.component));
});

test("normal window writes one report with actual dispatch origin, new PID and final identity; no stack", async t => {
  const f = await fixture(); t.after(f.close); const input = { ...f.input }, permission = { ...f.permission };
  const entry = createStartupStackProbe(input, permission, { runner: f.runner }); input.serial = "foreign"; permission.serial = "foreign";
  const report = await entry.run(f.controller.signal); assert.equal(report.status, "no-stack");
  assert.deepEqual(report.attempts, { launchCommands: 1, observationCalls: 1, captures: 0 });
  assert.equal(report.origin?.runId, report.runId); assert.deepEqual(report.process, { pid: 42, startTicks: "12345" });
  assert.equal(report.observation?.finalIdentityVerified, true); assert.equal(report.commandsSettled, true); assert.equal(report.reportSaved, true);
  const launched = report.commands.find(r => r.command.includes("am"))!;
  assert.equal(report.origin?.startedAt, launched.dispatchMono); assert.equal(launched.spawned, true); assert.equal(launched.closed, true);
  assert.deepEqual(await f.saved(report.output!), report);
  assert.equal((await f.state()).calls.filter((args: string[]) => args.includes("am")).length, 1);
  assert.equal(report.commands.some(r => ["content", "install", "force-stop", "-S", "-W", "compile"].some(s => r.command.includes(s))), false);
  const count = report.commands.length; await assert.rejects(entry.run(new AbortController().signal), /consumed/);
  assert.equal(f.runner.snapshot().length, count);
});

test("evidence directory, local digest, symlink and pre-cancel failures issue no device commands", async t => {
  for (const mode of ["directory", "hash", "symlink", "cancel"]) {
    const f = await fixture(); t.after(f.close); const input = { ...f.input };
    if (mode === "directory") input.outputRoot = f.apkPath;
    if (mode === "hash") await writeFile(f.apkPath, "changed");
    if (mode === "symlink") { const link = join(f.directory, "linked.apk"); await symlink(f.apkPath, link); input.apkPath = link; }
    if (mode === "cancel") f.controller.abort(Error("cancel preflight"));
    const report = await createStartupStackProbe(input, f.permission, { runner: f.runner }).run(f.controller.signal);
    assert.equal(report.status, "observation-failed"); assert.equal(report.commands.length, 0); assert.equal(report.attempts.launchCommands, 0);
    if (mode === "hash" || mode === "symlink") { assert.equal(report.reportSaved, true); assert.deepEqual(await f.saved(report.output!), report); }
  }
});

test("already-running, unknown pidof and non-debug targets stop before launch and preserve child exits", async t => {
  for (const mode of ["running", "pid-unknown", "not-debug"]) {
    const f = await fixture(mode); t.after(f.close);
    if (mode === "running") { const state = await f.state(); state.started = true; await writeFile(f.statePath, JSON.stringify(state)); }
    const report = await f.entry().run(f.controller.signal);
    assert.equal(report.status, "observation-failed"); assert.equal(report.attempts.launchCommands, 0);
    assert.equal(report.commands.some(r => r.command.includes("am")), false); assert.equal(report.reportSaved, true);
    if (mode !== "running") assert.equal(report.commands.at(-1)?.exitCode, 1);
  }
});

test("failed/warning exit0 launch records raw command evidence, stops without PID/capture retries", async t => {
  for (const mode of ["launch-error", "launch-warning", "launch-truncated"]) {
    const f = await fixture(mode); t.after(f.close); const report = await f.entry().run(f.controller.signal);
    assert.equal(report.status, "observation-failed"); assert.equal(report.attempts.launchCommands, 1);
    assert.equal(report.attempts.observationCalls, 0); assert.equal(report.process, undefined); assert.equal(report.reportSaved, true);
    assert.equal(report.commands.at(-1)?.exitCode, 0);
    if (mode === "launch-truncated") assert.equal(report.commands.at(-1)?.stderrTruncated, true);
    else assert.match(report.commands.at(-1)!.stderr, /Error|Warning/);
    assert.equal(report.errors[0].phase, "launch"); assert.deepEqual(await f.saved(report.output!), report);
  }
});

test("launch time remains the deadline origin and missing PID cannot trigger another launch", async t => {
  for (const mode of ["expired", "rewind", "pid-missing"]) {
    const f = await fixture(mode); t.after(f.close);
    const runner = { ...f.runner, execute: async (...args: Parameters<typeof f.runner.execute>) => {
      const result = await f.runner.execute(...args);
      if (args[0].includes("am")) f.setTime(mode === "expired" ? 18101 : mode === "rewind" ? 99 : 100);
      return result;
    } };
    const report = await createStartupStackProbe(f.input, f.permission, { runner, wait: async ms => f.setTime(runner.now() + ms) }).run(f.controller.signal);
    assert.equal(report.status, "observation-failed"); assert.equal(report.attempts.launchCommands, 1);
    assert.equal(report.attempts.observationCalls, 0); assert.equal(report.origin?.startedAt, 100);
    assert.equal(report.reportSaved, true); assert.deepEqual(await f.saved(report.output!), report);
    assert.equal(report.commands.filter(c => c.command.includes("am")).length, 1);
    if (mode !== "pid-missing") assert.equal(report.commands.at(-1)?.command.includes("am"), true);
  }
});

test("unjoined executor cancellation returns unknown cleanup, saves failure and ignores late output", async t => {
  const f = await fixture(); t.after(f.close); let complete!: (reply: Buffer) => void;
  const runner = { ...f.runner, execute: async () => {
    setTimeout(() => f.controller.abort(Error("cancel stalled command")), 20);
    return await new Promise<Buffer>(resolve => { complete = resolve; });
  }, finish: async () => false };
  const report = await createStartupStackProbe(f.input, f.permission, { runner }).run(f.controller.signal);
  assert.equal(report.status, "observation-failed"); assert.equal(report.commandsSettled, false);
  assert.equal(report.attempts.launchCommands, 0); assert.equal(report.reportSaved, true);
  assert.ok(report.errors.some(e => e.phase === "command-cleanup"));
  const before = JSON.stringify(report); complete(Buffer.from("late"));
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(JSON.stringify(report), before);
  assert.deepEqual(await f.saved(report.output!), report);
});

test("cancelling an actual launch child joins it, saves partial output and never follows up", async t => {
  const f = await fixture("launch-hang"); t.after(f.close); f.cancelLaunch();
  const report = await f.entry().run(f.controller.signal); assert.equal(report.status, "observation-failed");
  assert.equal(report.attempts.launchCommands, 1); assert.equal(report.attempts.observationCalls, 0);
  const record = report.commands.at(-1)!; assert.equal(record.closed, true); assert.equal(record.signal, "SIGKILL");
  assert.match(record.stdout, /Starting/); assert.equal(report.commandsSettled, true); assert.equal(report.reportSaved, true);
  const before = JSON.stringify(report); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(JSON.stringify(report), before);
  assert.deepEqual(await f.saved(report.output!), report);
});

test("driver never reuses a runner or a supplied historical process/time", async t => {
  const f = await fixture(); t.after(f.close); const entry = f.entry();
  await f.runner.execute(["-s", "fixture", "shell", "pm", "path", "example.app"], 1000, f.controller.signal);
  const report = await entry.run(f.controller.signal); assert.equal(report.status, "observation-failed"); assert.equal(report.attempts.launchCommands, 0);
  assert.throws(() => f.entry(), /fresh runner/);
});

test("real child commands and TCP integrate one 32-frame-limited sample, recovery and JSON failures", async t => {
  for (const badFrames of [false, true]) {
    const f = await fixture("normal", false); t.after(f.close);
    const sockets = new Set<Socket>(), packets: string[] = [];
    const server = createServer(socket => {
      sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
      let buffer = Buffer.alloc(0), handshake = true;
      socket.on("data", data => {
        buffer = Buffer.concat([buffer, data]);
        if (handshake) { if (buffer.length < 14) return; buffer = buffer.subarray(14); handshake = false; socket.write("JDWP-Handshake"); }
        while (buffer.length >= 11) {
          const len = buffer.readUInt32BE(); if (buffer.length < len) return;
          const req = buffer.subarray(0, len); buffer = buffer.subarray(len); const s = req[9], c = req[10]; packets.push(`${s}/${c}`);
          let payload = Buffer.alloc(0);
          if (s === 1 && c === 7) payload = Buffer.concat(Array(5).fill(int(4)));
          if (s === 1 && c === 4) payload = Buffer.concat([int(1), int(7)]);
          if (s === 11 && c === 1) payload = string("main"); if (s === 11 && c === 12) payload = int(0);
          if (s === 11 && c === 7) payload = int(100);
          if (s === 11 && c === 6) {
            assert.equal(req.readInt32BE(19), 32);
            payload = badFrames ? int(33) : Buffer.concat([int(1), int(9), Buffer.from([1]), int(10), int(11), Buffer.alloc(8)]);
          }
          if (s === 2 && c === 1) payload = string("Lexample/Main;");
          if (s === 2 && c === 5) payload = Buffer.concat([int(1), int(11), string("render"), string("()V"), int(1)]);
          const reply = Buffer.alloc(11 + payload.length); reply.writeUInt32BE(reply.length); reply.writeUInt32BE(req.readUInt32BE(4), 4);
          reply[8] = 0x80; payload.copy(reply, 11); socket.write(reply);
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const entry = createStartupStackProbe(f.input, f.permission, { runner: f.runner, choosePort: async () => address.port });
    const report = await entry.run(f.controller.signal);
    assert.equal(report.status, badFrames ? "observation-failed" : "stack-collected");
    assert.equal(report.observation?.cleanup.resumeVerified, true); assert.equal(report.observation?.cleanup.forwardRemoved, true);
    assert.equal(report.observation?.finalIdentityVerified, true); assert.equal(report.reportSaved, true);
    assert.equal(packets.filter(s => s === "11/2").length, 1); assert.equal(packets.filter(s => s === "11/6").length, 1);
    assert.equal(report.attempts.launchCommands, 1); assert.equal(report.commandsSettled, true);
    assert.equal(report.observation?.transport?.runId, report.runId);
    assert.equal(report.observation?.transport?.socketClosed, true);
    assert.ok(report.observation?.transport?.events.some(e => e.event === "handshake-received"));
    assert.deepEqual(await f.saved(report.output!), report);
    assert.equal((await f.state()).mapping, null); assert.ok(report.observation?.rawFramesReplyHex);
  }
});
