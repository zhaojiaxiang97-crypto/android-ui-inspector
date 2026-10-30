import assert from "node:assert/strict";
import { test } from "node:test";
import { createStartupWindowAdmission, parseStartupActivity, parseStartupWindows,
  type StartupAdmissionTarget, type StartupReadExecute } from "../scripts/diagnostics/startup/startup-window-admission";

const target: StartupAdmissionTarget = { serial: "fixture", packageName: "example.app", component: "example.app/.Home",
  pid: 42, startTicks: "12345", apkSha256: "a".repeat(64) };
const launch = { runId: "11111111-1111-1111-1111-111111111111", startedAt: 0, authorized: true as const };
const path = "/data/app/~~fixture/example.app-ab/base.apk";
const activityRecord = (id = "abc", component = target.component) => `ActivityRecord{${id} u0 ${component} t1}`;
const activities = (id = "abc", pid = 42, name = "example.app", component = target.component) =>
  `ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)\n topResumedActivity=${activityRecord(id, component)}\n` +
  ` * Hist #0: ${activityRecord(id, component)}\n  packageName=example.app processName=${name}\n  app=ProcessRecord{def ${pid}:${name}/u0a123}\n`;
const owner = { component: "example.app/example.app.Home", activityRecord: "abc", pid: 42 };
const displays = (focus = "null", id = "abc") =>
  `WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)\n Display: mDisplayId=0\n mCurrentFocus=${focus}\n mFocusedApp=${activityRecord(id)}\n`;
const window = (options: { id?: string; title?: string; pkg?: string; pid?: number; token?: string; type?: string } = {}) =>
  ` Window #0 Window{${options.id ?? "fed"} u0 ${options.title ?? target.component}}:\n` +
  `  mDisplayId=0 rootTaskId=1 mSession=Session{aaa ${options.pid ?? 42}:u0a123} mClient=Binder\n` +
  `  mOwnerUid=10123 showForAllUsers=false package=${options.pkg ?? target.packageName} appop=NONE\n` +
  `  mAttrs={(0,0)(fillxfill) sim={adjust=pan} ty=${options.type ?? "BASE_APPLICATION"} fmt=TRANSLUCENT\n   fl=HARDWARE_ACCELERATED}\n` +
  `  mActivityRecord=${activityRecord(options.token)}\n`;
const windows = (body = "") => `WINDOW MANAGER WINDOWS (dumpsys window windows)\n${body} mTopFocusedDisplayId=0\n`;
function processFrame(ticks = "12345", name = "example.app") {
  const fields = Array(25).fill("0"); fields[0] = "S"; fields[19] = ticks;
  const stat = `42 (name (with) spaces) ${fields.join(" ")}\n`;
  return Buffer.from(stat + name + "\0\0" + stat);
}
function fixture(started = 0) {
  const controller = new AbortController(), calls: { args: string[]; timeout: number; at: number }[] = [];
  let time = started, ready = Infinity, counter = 0;
  let patch: ((args: string[], reply: Buffer, n: number) => Buffer) | undefined;
  const execute: StartupReadExecute = async (args, timeout, signal) => {
    signal.throwIfAborted(); assert.deepEqual(args.slice(0, 2), ["-s", "fixture"]);
    assert.ok(timeout > 0 && timeout <= 5000);
    calls.push({ args, timeout, at: time }); time += 10;
    let reply: Buffer;
    if (args.includes("run-as")) { assert.equal(timeout <= 250, true); reply = processFrame(); }
    else if (args.includes("sha256sum")) reply = Buffer.from(`${target.apkSha256}  ${path}\n`);
    else if (args.includes("pm")) reply = Buffer.from(`package:${path}\n`);
    else if (args.at(-1) === "activities") reply = Buffer.from(activities());
    else if (args.at(-1) === "windows") reply = Buffer.from(windows(time >= ready ? window() : ""));
    else if (args.at(-1) === "displays") reply = Buffer.from(displays());
    else throw Error(`Forbidden command ${args.join(" ")}`);
    counter++;
    return patch ? patch(args, reply, counter) : reply;
  };
  const gate = (actual = target, origin = launch) => createStartupWindowAdmission(actual, origin, { execute,
    now: () => time, wait: async (ms, signal) => { signal.throwIfAborted(); time += ms; } });
  return { controller, calls, execute, gate, now: () => time, setTime: (ms: number) => { time = ms; },
    setReady: (ms: number) => { ready = ms; }, setPatch: (value: typeof patch) => { patch = value; } };
}

test("Activity owner is the exact resumed token, full/abbreviated component and main PID", () => {
  assert.deepEqual(parseStartupActivity(activities(), target), owner);
  assert.deepEqual(parseStartupActivity(activities("abc", 42, "example.app", owner.component), target), owner);
  const old = ` * Hist #1: ${activityRecord("bbb")}\n packageName=example.app processName=example.app\n app=ProcessRecord{ddd 99:example.app/u0a123}\n`;
  assert.deepEqual(parseStartupActivity(activities() + old, target), owner, "old task is not selected");
  assert.deepEqual(parseStartupActivity(activities().replace("topResumedActivity=", "mResumedActivity: "), target), owner);
});

test("unknown, ambiguous, foreign, app-null and reused Activity owners are rejected", () => {
  for (const text of ["", activities( "abc", 43), activities("abc", 42, "example.app:worker"),
    activities().replace("app=ProcessRecord{def 42:example.app/u0a123}", "app=null"),
    activities().replace("topResumedActivity", "unknownActivity"),
    activities() + `topResumedActivity=${activityRecord("bbb")}\n`,
    activities() + activities().split("topResumedActivity=")[1].split("\n").slice(1).join("\n"),
    activities().replace("topResumedActivity=" + activityRecord(), "topResumedActivity=" + activityRecord("bbb")),
    activities().replace(/u0/g, "u10"), activities("abc", 42, "example.app", "another.app/.Home"),
    activities().replace("packageName=example.app", "packageName=other.app"), "x".repeat(2 * 1024 * 1024 + 1)])
    assert.throws(() => parseStartupActivity(text, target));
});

test("window ownership uses its own package/session/Activity, not titles or IME references", () => {
  assert.deepEqual(parseStartupWindows(windows(), displays(), target, owner), { mainWindow: false, focus: null });
  for (const type of ["BASE_APPLICATION", "APPLICATION", "DRAWN_APPLICATION", "1", "2", "4"])
    assert.equal(parseStartupWindows(windows(window({ type, title: "Custom app title" })), displays(), target, owner).mainWindow, true);
  const system = window({ title: "InputMethod", pkg: "input.app", pid: 99, type: "INPUT_METHOD" }) +
    ` imeTarget=Window{fed u0 ${target.component}}\n`;
  assert.equal(parseStartupWindows(windows(system), displays(), target, owner).mainWindow, false);
  assert.equal(parseStartupWindows(windows(window({ type: "APPLICATION_STARTING", title: "Splash Screen example.app" })), displays(), target, owner).mainWindow, false);
  assert.equal(parseStartupWindows(windows(window()), displays(`Window{fed u0 ${target.component}}`), target, owner).mainWindow, true);
});

test("missing or conflicting window information is unknown, never a no-window proof", () => {
  for (const [w, d] of [
    ["", displays()], [windows(), ""], [windows().replace("mTopFocusedDisplayId=0", "mTopFocusedDisplayId=1"), displays()],
    [windows(), displays().replace("mCurrentFocus=null", "unknownFocus=null")],
    [windows(), displays() + "mCurrentFocus=null\n"], [windows(), displays("null", "bbb")],
    [windows(), displays().replace("mDisplayId=0", "mDisplayId=1")],
    [windows(), displays() + "Display: mDisplayId=1\n"],
    [windows(window()).replace("mAttrs=", "attrs="), displays()],
    [windows(window()).replace("ty=BASE_APPLICATION", "ty=UNKNOWN_APPLICATION"), displays()],
    [windows(window({ pid: 43 })), displays()], [windows(window({ token: "bbb" })), displays()],
    [windows(window({ pkg: "another.app" })), displays()],
    [windows(window()).replace("mDisplayId=0", "mDisplayId=1"), displays()],
    [windows(window()).replace("u0 example", "u10 example"), displays()],
    [windows(window()).replace("Window #0 Window", "Window #0 unknown"), displays()],
    [windows(window() + window()), displays()],
    [windows(window()), displays(`Window{bbb u0 another.app/.Home}`)],
    [windows(), displays(`Window{fed u0 ${target.component}}`)],
    [windows(), displays("Window{abc u0 unknown}")], [windows() + "\0", displays()],
    [windows(window()).replace("mSession=Session{aaa 42", "mSession=Unknown{aaa 42"), displays()],
  ]) assert.throws(() => parseStartupWindows(w, d, target, owner));
  assert.throws(() => parseStartupWindows(windows(), displays(), target, { ...owner, pid: 43 }), /target changed/);
  const crowded = Array.from({ length: 257 }, (_, i) => window({ id: (1000 + i).toString(16) }).replace("Window #0", `Window #${i}`)).join("");
  assert.throws(() => parseStartupWindows(windows(crowded), displays(), target, owner), /window list/);
});

test("construction validates explicit scope but has no reads, SDK, forward or launch", async () => {
  const f = fixture(); f.gate(); assert.equal(f.calls.length, 0);
  for (const patch of [{ serial: "bad; command" }, { component: "other.app/.Home" }, { pid: 0 }, { startTicks: "" }, { apkSha256: "unknown" }])
    assert.throws(() => f.gate({ ...target, ...patch }));
  for (const patch of [{ authorized: false }, { runId: "old" }, { startedAt: NaN }])
    assert.throws(() => f.gate(target, { ...launch, ...patch } as typeof launch));
  const reason = Error("cancel preflight"), gate = f.gate(); f.controller.abort(reason);
  await assert.rejects(gate.run(f.controller.signal), error => error === reason);
  await assert.rejects(gate.run(new AbortController().signal), /consumed/);
  assert.equal(f.calls.length, 0);
});

test("known installed SHA, process bracket and Activity/window reads admit only fresh delayed candidate", async () => {
  const f = fixture(), gate = f.gate(), result = await gate.run(f.controller.signal);
  assert.equal(result.status, "sample-due"); assert.deepEqual(result.owner, owner);
  assert.equal(result.runId, launch.runId); assert.ok(result.observedMs >= 12000 && result.observedMs < 15000);
  assert.ok(f.calls.some(call => call.args.includes("windows") && call.at >= 12000));
  assert.equal(f.calls.filter(call => call.args.includes("sha256sum")).length, 1);
  assert.ok(f.calls.every(call => !/content|forward|start|capture|screencap|jdwp/.test(call.args.join(" "))));
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.owner), true);
  const checked = await gate.recheckBeforeSample(f.controller.signal);
  assert.equal(checked.status, "sample-due"); assert.ok(checked.observedMs > result.observedMs);
  await assert.rejects(gate.recheckBeforeSample(f.controller.signal), /consumed/);
  await assert.rejects(gate.run(f.controller.signal), /consumed/);
});

test("early, threshold and between-bracket main window readiness stops without stack admission", async () => {
  for (const ready of [0, 12000]) {
    const f = fixture(); f.setReady(ready); const gate = f.gate();
    assert.equal((await gate.run(f.controller.signal)).status, "window-ready");
    await assert.rejects(gate.recheckBeforeSample(f.controller.signal), /unavailable/);
  }
  const f = fixture(12000); let windowReads = 0;
  f.setPatch((args, reply) => args.at(-1) === "windows" && ++windowReads === 2 ? Buffer.from(windows(window())) : reply);
  assert.equal((await f.gate().run(f.controller.signal)).status, "window-ready");
  assert.equal(windowReads, 2);
});

test("candidate recheck sees newly ready windows and refuses changed process/Activity/installation", async () => {
  for (const mode of ["ready", "pid", "activity", "path", "focus", "unknown"]) {
    const f = fixture(), gate = f.gate(); await gate.run(f.controller.signal);
    f.setPatch((args, reply) => {
      if (mode === "pid" && args.includes("run-as")) return processFrame("12346");
      if (mode === "activity" && args.at(-1) === "activities") return Buffer.from(activities("bbb"));
      if (mode === "path" && args.includes("pm")) return Buffer.from(`package:${path.replace("ab", "cd")}`);
      if (mode === "focus" && args.at(-1) === "displays") return Buffer.from(displays("Window{abc u0 other.app/.Home}"));
      if (mode === "unknown" && args.at(-1) === "windows") return Buffer.from("unknown");
      return reply;
    });
    if (mode === "ready") { f.setReady(0); assert.equal((await gate.recheckBeforeSample(f.controller.signal)).status, "window-ready"); }
    else await assert.rejects(gate.recheckBeforeSample(f.controller.signal));
    await assert.rejects(gate.recheckBeforeSample(f.controller.signal), /consumed/);
  }
});

test("preflight wrong SHA/split/path and unknown/foreign/changed observation stop without fallback", async () => {
  for (const mode of ["sha", "split", "changed-path", "process", "owner", "after-owner", "window", "displays", "foreign-focus"]) {
    const f = fixture(); let activitiesRead = 0, paths = 0;
    f.setPatch((args, reply) => {
      if (mode === "sha" && args.includes("sha256sum")) return Buffer.from(`${"b".repeat(64)}  ${path}`);
      if (mode === "split" && args.includes("pm")) return Buffer.from(`package:${path}\npackage:/data/app/split.apk`);
      if (mode === "changed-path" && args.includes("pm") && ++paths > 1) return Buffer.from(`package:${path.replace("ab", "cd")}`);
      if (mode === "process" && args.includes("run-as")) return processFrame("12346");
      if (args.at(-1) === "activities") {
        activitiesRead++;
        if (mode === "owner") return Buffer.from(activities("abc", 43));
        if (mode === "after-owner" && activitiesRead > 1) return Buffer.from(activities("bbb"));
      }
      if (mode === "window" && args.at(-1) === "windows") return Buffer.from("unknown");
      if (mode === "displays" && args.at(-1) === "displays") return Buffer.from("unknown");
      if (mode === "foreign-focus" && args.at(-1) === "displays") return Buffer.from(displays("Window{aaa u0 other.app/.Home}"));
      return reply;
    });
    const gate = f.gate(); await assert.rejects(gate.run(f.controller.signal));
    const count = f.calls.length;
    await assert.rejects(gate.run(f.controller.signal), /consumed/);
    await assert.rejects(gate.recheckBeforeSample(f.controller.signal), /unavailable/);
    assert.equal(f.calls.length, count);
  }
});

test("cancellation and late results at every read boundary send no follow-up", async () => {
  for (const mode of ["cancel", "late"]) {
    for (let boundary = 1; boundary <= 13; boundary++) {
      const f = fixture(12000), reason = Error("cancel read");
      f.setPatch((_args, reply, n) => {
        if (n === boundary) { if (mode === "cancel") f.controller.abort(reason); else f.setTime(15000); }
        return reply;
      });
      const gate = f.gate(); await assert.rejects(gate.run(f.controller.signal), mode === "cancel" ? error => error === reason : /deadline/);
      assert.equal(f.calls.length, boundary);
    }
  }
});

test("process reuse in the trailing identity bracket and malformed fresh windows prevent admission", async () => {
  for (const mode of ["process", "windows", "displays"]) {
    const f = fixture(12000); let processReads = 0, windowReads = 0, displayReads = 0;
    f.setPatch((args, reply) => {
      if (mode === "process" && args.includes("run-as") && ++processReads === 2) return processFrame("12346");
      if (mode === "windows" && args.at(-1) === "windows" && ++windowReads === 2) return Buffer.from("unknown fresh windows");
      if (mode === "displays" && args.at(-1) === "displays" && ++displayReads === 2) return Buffer.from(displays("null", "bbb"));
      return reply;
    });
    const gate = f.gate(); await assert.rejects(gate.run(f.controller.signal));
    await assert.rejects(gate.recheckBeforeSample(f.controller.signal), /unavailable/);
  }
});

test("each pre-sample recheck boundary preserves cancellation/deadline and cannot be replayed", async () => {
  for (const mode of ["cancel", "late"]) {
    for (let boundary = 1; boundary <= 10; boundary++) {
      const f = fixture(), gate = f.gate(); await gate.run(f.controller.signal);
      const initial = f.calls.length, reason = Error("cancel recheck");
      f.setPatch((_args, reply, n) => {
        if (n - initial === boundary) { if (mode === "cancel") f.controller.abort(reason); else f.setTime(15000); }
        return reply;
      });
      await assert.rejects(gate.recheckBeforeSample(f.controller.signal), mode === "cancel" ? error => error === reason : /deadline/);
      assert.equal(f.calls.length, initial + boundary);
      await assert.rejects(gate.recheckBeforeSample(new AbortController().signal), /consumed/);
    }
  }
});

test("candidate cannot replace its original cancellation signal to keep observing", async () => {
  for (const cancelled of [false, true]) {
    const f = fixture(), gate = f.gate(); await gate.run(f.controller.signal);
    const calls = f.calls.length, reason = Error("cancel admitted run");
    if (cancelled) f.controller.abort(reason);
    await assert.rejects(gate.recheckBeforeSample(new AbortController().signal), cancelled ? error => error === reason : /signal changed/);
    assert.equal(f.calls.length, calls);
    await assert.rejects(gate.recheckBeforeSample(f.controller.signal), /consumed/);
  }
});

test("a stalled injected clock/wait cannot produce an unbounded device-read loop", async () => {
  const f = fixture(); let calls = 0;
  const gate = createStartupWindowAdmission(target, launch, { execute: async (...args) => { calls++; return f.execute(...args); },
    now: () => 0, wait: async () => {} });
  await assert.rejects(gate.run(f.controller.signal), /read limit/);
  assert.equal(calls, 3 + 16 * 10);
});

test("same-run origin is immutable, rejects old/future/rewound clocks and does not restart budget", async () => {
  for (const time of [-1, 15000, 16000, NaN]) {
    const f = fixture(time); await assert.rejects(f.gate().run(f.controller.signal), /clock|deadline/);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(14990); await assert.rejects(f.gate().run(f.controller.signal), /deadline/);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].timeout, 10);
  const rewind = fixture(); rewind.setPatch((_args, reply) => { rewind.setTime(-1); return reply; });
  await assert.rejects(rewind.gate().run(rewind.controller.signal), /clock/);
  const mutable = { ...target }, origin = { ...launch }, stable = fixture(), gate = stable.gate(mutable, origin);
  mutable.pid = 99; origin.startedAt = 12000; origin.runId = "22222222-2222-2222-2222-222222222222";
  const result = await gate.run(stable.controller.signal); assert.equal(result.runId, launch.runId); assert.equal(result.owner.pid, 42);
  stable.setTime(15000); await assert.rejects(gate.recheckBeforeSample(stable.controller.signal), /deadline/);
});

test("read/transport limits and wait cancellation cannot become a startup candidate", async () => {
  for (const value of [Buffer.alloc(2 * 1024 * 1024 + 1), "not a Buffer", null]) {
    const f = fixture(); f.setPatch(() => value as Buffer);
    await assert.rejects(f.gate().run(f.controller.signal), /Invalid/); assert.equal(f.calls.length, 1);
  }
  const f = fixture(); let calls = 0;
  const gate = createStartupWindowAdmission(target, launch, { execute: async () => { calls++; throw Error("transport failed"); }, now: f.now });
  await assert.rejects(gate.run(f.controller.signal), /transport failed/); assert.equal(calls, 1);
  const wait = fixture(), reason = Error("cancel wait");
  const waiting = createStartupWindowAdmission(target, launch, { execute: wait.execute, now: wait.now,
    wait: async () => { wait.controller.abort(reason); } });
  await assert.rejects(waiting.run(wait.controller.signal), error => error === reason);
  assert.equal(wait.calls.length, 13);
});
