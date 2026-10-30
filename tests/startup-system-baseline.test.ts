import assert from "node:assert/strict";
import { test } from "node:test";
import { observeStartupSystem } from "../scripts/diagnostics/startup/startup-system-baseline";

const component = "com.example.test/.MainActivity";
const foreground = `topResumedActivity=ActivityRecord{b22 u0 ${component} t2}`;
const window = "mCurrentFocus=Window{abc u0 com.example.test/.MainActivity}";
const setup = () => {
  let ms = 0;
  const controller = new AbortController();
  const calls: { command: string; timeout: number; started: number }[] = [];
  const options = { component, now: () => ms, signal: controller.signal,
    sleep: async (delay: number, signal: AbortSignal) => { signal.throwIfAborted(); ms += delay; },
    read: async (args: string[], timeout: number, signal: AbortSignal): Promise<string> => {
      signal.throwIfAborted(); calls.push({ command: args.join(" "), timeout, started: ms }); ms += 10;
      return args.at(-1) === "activities" ? foreground : window;
    } };
  return { options, calls, controller, setTime: (value: number) => { ms = value; } };
};

test("system-only baseline has five sparse slots, ten system reads and relative query boundaries", async () => {
  const { options, calls } = setup();
  const r = await observeStartupSystem(options);
  assert.equal(r.status, "completed"); assert.equal(r.elapsedMs, 24020);
  assert.equal(r.firstCandidateMs, 20);
  assert.deepEqual(r.records.map(s => s.scheduledMs), [0, 6000, 12000, 18000, 24000]);
  assert.deepEqual(r.records[0].reads.map(q => [q.startedMs, q.endedMs]), [[0, 10], [10, 20]]);
  assert.equal(calls.length, 10);
  for (const c of calls) assert.ok(["shell dumpsys activity activities", "shell dumpsys window windows"].includes(c.command));
  assert.ok(!JSON.stringify(calls).match(/run-as|pidof|screencap|content|forward|capture|activity com.example/));
});

test("missing focus field uses displays fallback only, actual null never falls back", async () => {
  for (const missing of [true, false]) {
    const { options, calls } = setup(); const read = options.read;
    options.read = async (args, timeout, signal) => {
      const text = await read(args, timeout, signal);
      return args.at(-1) === "windows" ? missing ? "no focus field" : "mCurrentFocus=null" : text;
    };
    const r = await observeStartupSystem(options);
    assert.equal(calls.length, missing ? 15 : 10);
    assert.equal(r.firstCandidateMs, missing ? 30 : null);
    assert.equal(r.records.every(s => s.candidate), missing);
  }
});

test("missing/ambiguous/wrong foreground or focus never establishes a candidate", async () => {
  for (const [activities, windows] of [[foreground + "\n" + foreground.replace("b22", "c33"), window],
    [foreground.replace("b22", "unknown"), window], [foreground.replace(".MainActivity", ".OtherActivity"), window],
    [foreground, window + "\n" + window], [foreground, window.replace("com.example.test/", "com.other.app/")]]) {
    const { options } = setup(); options.read = async args => args.at(-1) === "activities" ? activities : windows;
    const r = await observeStartupSystem(options);
    assert.equal(r.firstCandidateMs, null); assert.ok(r.records.every(s => !s.candidate && s.reason));
  }
});

test("slow query closes its interval and remaining budget does not permit another read", async () => {
  const { options, calls, setTime } = setup(); const read = options.read;
  options.read = async (args, timeout, signal) => { await read(args, timeout, signal); setTime(29000); throw new Error("query timeout"); };
  const r = await observeStartupSystem(options);
  assert.equal(r.status, "budget-exhausted"); assert.equal(calls.length, 1);
  assert.equal(r.records[0].reads[0].endedMs, 29000);
  assert.match(r.records[0].reason!, /query timeout/);
  assert.equal(calls[0].timeout, 6000);
});

test("late samples never restart the deadline and each child timeout fits the remaining budget", async () => {
  const { options, calls } = setup(); const read = options.read;
  options.sleep = async () => { /* injected busy system: scheduling does not advance time */ };
  let ms = 0;
  options.now = () => ms;
  options.read = async (args, timeout, signal) => { const output = await read(args, timeout, signal); ms += 5700; return output; };
  const r = await observeStartupSystem(options);
  assert.equal(r.status, "budget-exhausted"); assert.equal(r.records.length, 3);
  assert.deepEqual(calls.map(c => c.timeout), [6000, 6000, 6000, 6000, 6000, 1500]);
});

test("cancellation during query or scheduled wait saves partial records without further queries", async () => {
  for (const duringRead of [true, false]) {
    const { options, controller, calls } = setup(); const read = options.read;
    if (duringRead) options.read = async (args, timeout, signal) => {
      await read(args, timeout, signal); controller.abort(new Error("cancel")); signal.throwIfAborted(); return "";
    };
    else options.sleep = async (_, signal) => { controller.abort(new Error("cancel")); signal.throwIfAborted(); };
    const r = await observeStartupSystem(options);
    assert.equal(r.status, "cancelled"); assert.equal(calls.length, duringRead ? 1 : 2);
    assert.equal(r.records.length, 1);
    assert.equal(r.records[0].reads[0].endedMs, 10);
  }
});
