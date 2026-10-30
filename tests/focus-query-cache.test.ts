import assert from "node:assert/strict";
import { test } from "node:test";
import { createDebugFocusReader, FOCUS_QUERY_CACHE_LIMIT, FOCUS_QUERY_CACHE_TTL_MS } from "../electron/device/target";
import { withCommandSignal } from "../electron/device/command-context";
import type { CommandResult } from "../electron/device/runtime";

const focus = (id = "abc", pkg = "com.example.test") => `mTopFocusedDisplayId=0\nmCurrentFocus=Window{${id} u0 ${pkg}/.Main}`;
const missing = "WINDOW MANAGER WINDOWS (dumpsys window windows)\nmTopFocusedDisplayId=0";
const result = (stdout: string, code: number | null = 0, stderr = ""): CommandResult => ({ code, stdout: Buffer.from(stdout), stderr });
type Reply = string | CommandResult | Error | Promise<CommandResult>;
function fixture(replies: Reply[], clock?: () => number) {
  const calls: { adbPath: string; serial: string; query: string }[] = [];
  const read = createDebugFocusReader(async (adbPath, serial, args) => {
    assert.deepEqual(args.slice(0, 3), ["shell", "dumpsys", "window"]);
    calls.push({ adbPath, serial, query: args[3] ?? "all" });
    const next = replies.shift();
    assert.notEqual(next, undefined, "unexpected additional query");
    if (next instanceof Error) throw next;
    return typeof next === "string" ? result(next) : await next!;
  }, clock);
  return { read, replies, calls, queries: () => calls.map(call => call.query) };
}
function deferred() {
  let resolve!: (value: CommandResult) => void;
  const promise = new Promise<CommandResult>(done => { resolve = done; });
  return { promise, resolve };
}

test("windows devices use one live query every time and never reuse a focus value", async () => {
  const h = fixture([focus("aaa"), focus("bbb", "com.other.app")]);
  assert.deepEqual(await h.read("adb", "one"), { id: "aaa", packageName: "com.example.test" });
  assert.deepEqual(await h.read("adb", "one"), { id: "bbb", packageName: "com.other.app" });
  assert.deepEqual(h.queries(), ["windows", "windows"]);
});

test("full window dumps learn once and remove only the redundant windows query", async () => {
  const h = fixture([missing, focus("aaa"), focus("bbb")]);
  assert.equal((await h.read("adb", "one")).id, "aaa");
  assert.equal((await h.read("adb", "one")).id, "bbb");
  assert.deepEqual(h.queries(), ["windows", "all", "all"]);
});

test("full dumps validate the global display even when it appears after per-display sections", async () => {
  const full = `WINDOW MANAGER DISPLAY CONTENTS
    Display: mDisplayId=0
      mCurrentFocus=Window{aaa u0 com.example.test/.Main}
    Display: mDisplayId=2
      mCurrentFocus=Window{bbb u0 com.other.app/.Main}
    WINDOW MANAGER WINDOWS
      mTopFocusedDisplayId=0`;
  const h = fixture([missing, full, full.replace("mTopFocusedDisplayId=0", "mTopFocusedDisplayId=2")]);
  assert.deepEqual(await h.read("adb", "one"), { id: "aaa", packageName: "com.example.test" });
  await assert.rejects(h.read("adb", "one"), error => (error as { focusReason?: string }).focusReason === "non-primary-display");
  assert.deepEqual(h.queries(), ["windows", "all", "all"]);
  for (const bad of [
    full.replace("mCurrentFocus=Window{aaa u0 com.example.test/.Main}", "mCurrentFocus=null"),
    full.replace("Display: mDisplayId=2", "Display: mDisplayId=0"),
  ]) {
    const reject = fixture([missing, bad]);
    await assert.rejects(reject.read("adb", "one"));
    assert.deepEqual(reject.queries(), ["windows", "all"]);
  }
});

test("full dumps without global focus context are rejected while legacy windows remain supported", async () => {
  const legacy = focus().replace("mTopFocusedDisplayId=0\n", "");
  const h = fixture([missing, legacy]);
  await assert.rejects(h.read("adb", "one"), error => (error as { focusReason?: string }).focusReason === "unrecognized-focus-format");
  assert.deepEqual(h.queries(), ["windows", "all"]);
  const windows = fixture([legacy, legacy]);
  await windows.read("adb", "one");
  await windows.read("adb", "one");
  assert.deepEqual(windows.queries(), ["windows", "windows"], "legacy global windows focus remains supported");
});

test("a cached full query losing its global focus field fails and reprobes next time", async () => {
  const legacy = focus().replace("mTopFocusedDisplayId=0\n", "");
  const h = fixture([missing, focus(), legacy, missing, focus()]);
  await h.read("adb", "one");
  await assert.rejects(h.read("adb", "one"), error => (error as { focusReason?: string }).focusReason === "unrecognized-focus-format");
  await h.read("adb", "one");
  assert.deepEqual(h.queries(), ["windows", "all", "all", "windows", "all"]);
});

test("a missing field relearns the layout in either direction", async () => {
  const h = fixture([missing, focus(), missing, focus(), focus(), missing, focus(), focus()]);
  for (let i = 0; i < 5; i++) await h.read("adb", "one");
  assert.deepEqual(h.queries(), ["windows", "all", "all", "windows", "windows", "windows", "all", "all"]);
});

test("null, ambiguous, secondary-display and malformed focus never use a donor query", async () => {
  for (const [output, reason] of [
    ["mCurrentFocus=null", "null-focus"],
    [`${focus()}\n${focus()}`, "ambiguous-focus-field"],
    [focus().replace("mTopFocusedDisplayId=0", "mTopFocusedDisplayId=2"), "non-primary-display"],
    ["mTopFocusedDisplayId=2", "non-primary-display"],
    ["Display: mDisplayId=2", "missing-primary-display"],
    ["mCurrentFocus=Window{abc u0 PopupWindow:123}", "unrecognized-focus-format"],
    [`mTopFocusedDisplayId=0\n${focus()}`, "ambiguous-focus-field"],
    [`mTopFocusedDisplayId=2\n${focus()}`, "ambiguous-focus-field"],
    [focus().replace("mTopFocusedDisplayId=0", "mTopFocusedDisplayId=unknown"), "unrecognized-focus-format"],
    [focus().replace("mTopFocusedDisplayId=0", "mTopFocusedDisplayId="), "unrecognized-focus-format"],
    [`Display: mDisplayId=0\nDisplay: mDisplayId=2\n${focus()}`, "missing-focus-field"],
  ]) {
    const h = fixture([missing, focus(), output, missing, focus()]);
    await h.read("adb", "one");
    await assert.rejects(h.read("adb", "one"), error => (error as { focusReason?: string }).focusReason === reason);
    assert.deepEqual(h.queries(), ["windows", "all", "all"]);
    await h.read("adb", "one");
    assert.deepEqual(h.queries(), ["windows", "all", "all", "windows", "all"], "unavailable focus invalidates learned layout");
    const cold = fixture([output]);
    await assert.rejects(cold.read("adb", "one"));
    assert.deepEqual(cold.queries(), ["windows"]);
  }
});

test("command failures, permission failures and transport exceptions invalidate without fallback", async () => {
  for (const failed of [
    result(missing, 1), result(focus(), null), result("Permission Denial: can't dump WindowManager"),
    result(focus(), 0, "java.lang.SecurityException: denied"), result("Can't find service: window"),
    result("*** DUMP TIMEOUT ***"), new Error("transport timeout"), new Error("device offline"),
  ]) {
    const h = fixture([missing, focus(), failed, missing, focus()]);
    await h.read("adb", "one");
    await assert.rejects(h.read("adb", "one"));
    assert.deepEqual(h.queries(), ["windows", "all", "all"]);
    await h.read("adb", "one");
    assert.deepEqual(h.queries(), ["windows", "all", "all", "windows", "all"]);
    const cold = fixture([failed]);
    await assert.rejects(cold.read("adb", "one"));
    assert.deepEqual(cold.queries(), ["windows"]);
  }
});

test("neither layout providing focus fails after two queries and is not learned", async () => {
  const h = fixture([missing, missing, missing, focus()]);
  await assert.rejects(h.read("adb", "one"), error => (error as { focusReason?: string }).focusReason === "missing-focus-field");
  await h.read("adb", "one");
  assert.deepEqual(h.queries(), ["windows", "all", "windows", "all"]);
});

test("query preferences are isolated by both ADB path and device serial", async () => {
  const h = fixture([missing, focus(), missing, focus(), missing, focus(), focus(), focus(), focus()]);
  const devices = [["adb-a", "one"], ["adb-a", "two"], ["adb-b", "one"]];
  for (let round = 0; round < 2; round++) for (const [adb, serial] of devices) await h.read(adb, serial);
  assert.deepEqual(h.queries(), ["windows", "all", "windows", "all", "windows", "all", "all", "all", "all"]);
  assert.deepEqual(h.calls.slice(-3).map(({ adbPath, serial }) => [adbPath, serial]), devices);
});

test("the bounded cache evicts the least recently requested device", async () => {
  const replies: Reply[] = [];
  for (let i = 0; i <= FOCUS_QUERY_CACHE_LIMIT; i++) replies.push(missing, focus());
  replies.push(focus(), missing, focus());
  const h = fixture(replies);
  for (let i = 0; i <= FOCUS_QUERY_CACHE_LIMIT; i++) await h.read("adb", `device-${i}`);
  await h.read("adb", `device-${FOCUS_QUERY_CACHE_LIMIT}`);
  await h.read("adb", "device-0");
  assert.deepEqual(h.queries().slice(-3), ["all", "windows", "all"]);
});

test("idle expiry probes again while recent successful reads renew the preference", async () => {
  let now = 0;
  const h = fixture([missing, focus(), focus(), focus(), missing, focus()], () => now);
  await h.read("adb", "one");
  now += FOCUS_QUERY_CACHE_TTL_MS - 1;
  await h.read("adb", "one");
  now += FOCUS_QUERY_CACHE_TTL_MS - 1;
  await h.read("adb", "one");
  now += FOCUS_QUERY_CACHE_TTL_MS;
  await h.read("adb", "one");
  assert.deepEqual(h.queries(), ["windows", "all", "all", "all", "windows", "all"]);
});

test("overlapping callers query independently and an older result cannot overwrite a newer layout", async () => {
  const pending = deferred();
  const h = fixture([missing, focus(), pending.promise, focus("bbb"), focus("aaa"), focus("ccc")]);
  await h.read("adb", "one");
  const older = h.read("adb", "one");
  const newer = h.read("adb", "one");
  assert.equal((await newer).id, "bbb");
  pending.resolve(result(missing));
  assert.equal((await older).id, "aaa");
  assert.equal((await h.read("adb", "one")).id, "ccc");
  assert.deepEqual(h.queries(), ["windows", "all", "all", "all", "windows", "all"]);
});

test("an older failure does not clear a newer successful preference", async () => {
  const pending = deferred();
  const h = fixture([missing, focus(), pending.promise, focus("bbb"), focus("ccc")]);
  await h.read("adb", "one");
  const older = h.read("adb", "one");
  await h.read("adb", "one");
  pending.resolve(result("mCurrentFocus=null"));
  await assert.rejects(older);
  await h.read("adb", "one");
  assert.deepEqual(h.queries().slice(-3), ["all", "all", "all"]);
});

test("an older successful request cannot restore a preference invalidated by a newer failure", async () => {
  const pending = deferred();
  const h = fixture([missing, focus(), pending.promise, "mCurrentFocus=null", missing, focus()]);
  await h.read("adb", "one");
  const older = h.read("adb", "one");
  await assert.rejects(h.read("adb", "one"));
  pending.resolve(result(focus()));
  await older;
  await h.read("adb", "one");
  assert.deepEqual(h.queries().slice(-2), ["windows", "all"]);
});

test("cancelled requests cannot publish or cache focus and pre-cancelled calls issue no query", async () => {
  const pending = deferred(), controller = new AbortController();
  const h = fixture([missing, focus(), pending.promise, missing, focus()]);
  await h.read("adb", "one");
  const cancelled = withCommandSignal(controller.signal, () => h.read("adb", "one"));
  controller.abort(new Error("cancelled"));
  pending.resolve(result(focus()));
  await assert.rejects(cancelled, /cancelled/);
  await h.read("adb", "one");
  assert.deepEqual(h.queries(), ["windows", "all", "all", "windows", "all"]);
  const count = h.calls.length;
  await assert.rejects(withCommandSignal(controller.signal, () => h.read("adb", "one")), /cancelled/);
  assert.equal(h.calls.length, count);
});
