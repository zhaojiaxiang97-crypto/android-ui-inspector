import assert from "node:assert/strict";
import { test } from "node:test";
import { createCaptureReadiness, isCaptureReadiness } from "../shared/capture-readiness";
import { recordCaptureAttempt, isCaptureRequestDiagnostics } from "../shared/capture-attempts";
import { isUiSnapshot } from "../shared/snapshot-validation";
import type { UiSnapshot } from "../shared/types";
import { FocusUnavailableError, parseFocusedWindowState } from "../electron/device/target";

const focus = { component: "sample/.Main", activityRecordId: "abc", windowId: "def" };
const snapshot = (): UiSnapshot => ({ serial: "sample", root: null, nodeCount: 0, xmlSize: 0,
  rawXml: null, screenshotDataUrl: null, error: "failed", warning: null });

test("coded focus failures survive saved diagnostics without raw output and old rows remain valid", async () => {
  let ms = 0;
  const r = createCaptureReadiness(18000, () => ms);
  for (const source of ["mCurrentFocus=null", "mTopFocusedDisplayId=2", "Display: mDisplayId=2",
    "private raw dump", "mCurrentFocus=null\nmCurrentFocus=null", "mCurrentFocus=bad private dump"]) {
    const p = parseFocusedWindowState(source);
    const error = new FocusUnavailableError(p.reasonCode!, p.reason!);
    await assert.rejects(r.observe("focus-candidate", async () => { ms++; throw error; }, undefined,
      e => e instanceof FocusUnavailableError ? { result: "unavailable", focusReason: e.focusReason } : "error"), e => e === error);
  }
  const d = r.snapshot();
  const attempts = recordCaptureAttempt([], { ...snapshot(), captureReadiness: d }, 1, 0, ms);
  const saved = JSON.parse(JSON.stringify(attempts[0].readiness));
  assert.equal(isCaptureReadiness(saved), true);
  assert.equal(JSON.stringify(saved).includes("private"), false);
  assert.deepEqual(saved.observations.entries.map((row: { focusReason: string }) => row.focusReason),
    ["null-focus", "non-primary-display", "missing-primary-display", "missing-focus-field", "ambiguous-focus-field", "unrecognized-focus-format"]);
  for (const row of saved.observations.entries) delete row.focusReason;
  assert.equal(isCaptureReadiness(saved), true, "old unavailable observations are unknown, not inferred null focus");
  const row = saved.observations.entries[0];
  for (const bad of [{ focusReason: "raw dump" }, { focusReason: null }, { focusReason: {} },
    { focusReason: "null-focus", result: "match" }, { focusReason: "null-focus", kind: "foreground" }]) {
    saved.observations.entries[0] = { ...row, ...bad };
    assert.equal(isCaptureReadiness(saved), false);
  }
});

test("delayed focus records actual confirmation, not stage entry; insufficient budget has no invented tree", () => {
  let ms = 100;
  const r = createCaptureReadiness(18000, () => ms);
  r.phase("focus-before"); ms = 17500; r.focused(focus);
  ms = 18000;
  const d = r.snapshot("remaining budget insufficient");
  assert.equal(d.firstFocusedWindowMs, 17500);
  assert.equal(d.treeReadCount, 0);
  assert.equal(d.phase, "focus-before");
  assert.equal(isCaptureReadiness(d), true);
});

test("tree timeout closes interval and failure survives root clearing and attempt renumbering", async () => {
  let ms = 15000;
  const r = createCaptureReadiness(18000, () => ms);
  r.focused(focus);
  await assert.rejects(r.read(async () => { ms = 18008; throw new Error("tree timeout"); }));
  const s = { ...snapshot(), captureReadiness: r.snapshot("tree timeout") };
  s.captureRequestDiagnostics = { totalDurationMs: ms, totalAttempts: 1, droppedAttempts: 0,
    attempts: recordCaptureAttempt([], s, 1, 0, ms) };
  const entry = recordCaptureAttempt([], { ...snapshot(), captureRequestDiagnostics: s.captureRequestDiagnostics }, 2, 20000, ms)[0];
  assert.deepEqual(entry.readiness?.treeReads, [{ startedMs: 15000, endedMs: 18008 }]);
  assert.equal(entry.readiness?.phase, "tree");
  assert.equal(entry.processId, null, "no guessed process identity");
  s.captureReadiness.treeReads[0].endedMs = 0;
  assert.equal(entry.readiness?.treeReads[0].endedMs, 18008);
  assert.equal(s.root, null);
});

test("window switch stays rejected, ready diagnostics freeze before subsequent image capture", async () => {
  let ms = 100;
  const r = createCaptureReadiness(18000, () => ms);
  r.focused(focus);
  await r.read(async () => { ms = 200; });
  r.phase("focus-after");
  assert.equal(r.snapshot("window changed").phase, "focus-after");
  assert.equal(r.snapshot().focus?.windowId, focus.windowId);
  r.ready(); ms = 12000;
  assert.equal(r.snapshot("later image failed").elapsedMs, 200);
  assert.equal(r.snapshot().rejection, null);
});

test("cancellation propagates and does not become a ready capture", async () => {
  let ms = 10;
  const r = createCaptureReadiness(18000, () => ms);
  const controller = new AbortController();
  const reason = new Error("cancelled");
  await assert.rejects(r.read(async () => { ms = 20; controller.abort(reason); controller.signal.throwIfAborted(); }), reason);
  assert.equal(r.snapshot("cancelled").phase, "tree");
  assert.equal(r.snapshot().treeReads[0].endedMs, 20);
});

test("bounded scalar copies exclude extra payloads and malformed saved records are rejected", async () => {
  let ms = 0;
  const r = createCaptureReadiness(18000, () => ms);
  r.focused(focus);
  for (let i = 0; i < 20; i++) await r.read(async () => { ms++; });
  r.ready();
  const d = r.snapshot();
  assert.equal(d.treeReads.length, 8);
  assert.equal(d.treeReadCount, 20);
  assert.equal(isCaptureReadiness(d), true);
  const s = { ...snapshot(), captureReadiness: { ...d, pixels: "private" }, captureDurationMs: 20 };
  const attempts = recordCaptureAttempt([], s, 1, 0, 20);
  assert.equal(JSON.stringify(attempts).includes("private"), false);
  assert.equal(isUiSnapshot(snapshot()), true);
  for (const bad of [{ ...d, elapsedMs: -1 }, { ...d, firstFocusedWindowMs: 21 },
    { ...d, treeReadCount: 0 }, { ...d, focus: null }, { ...d, rejection: "failed" },
    { ...d, treeReads: [{ startedMs: 2, endedMs: 1 }] }]) {
    assert.equal(isUiSnapshot({ ...snapshot(), captureReadiness: bad }), false);
    assert.equal(isCaptureRequestDiagnostics({ totalDurationMs: 20, totalAttempts: 1, droppedAttempts: 0,
      attempts: [{ ...attempts[0], readiness: bad }] }), false);
  }
});

test("candidate observation does not authorize a tree or invent strict focus time", async () => {
  let ms = 100;
  const r = createCaptureReadiness(18000, () => ms);
  await r.observe("poll-wait", async () => { ms = 600; }, () => ({ result: "waited" }));
  await assert.rejects(r.observe("focus-candidate", async () => { ms = 750; throw Error("no focus"); },
    undefined, () => "unavailable"), /no focus/);
  await r.observe("focus-candidate", async () => { ms = 1000; return { id: "def" }; },
    value => ({ result: "match", windowId: value.id }));
  assert.equal(r.snapshot().firstFocusedWindowMs, null);
  assert.equal(r.snapshot().focus, null);
  assert.equal(r.snapshot().treeReadCount, 0);
  await r.observe("focus-confirm-before", async () => { ms = 16701; return focus; },
    value => ({ result: "match", component: value.component, windowId: value.windowId }));
  r.focused(focus); r.budgetStop();
  const d = r.snapshot("remaining budget insufficient");
  assert.equal(d.firstFocusedWindowMs, 16701);
  assert.equal(d.observations?.entries[2].endedMs, 1000, "candidate and strict confirmation times remain distinct");
  assert.deepEqual(d.observations?.entries.at(-1), { kind: "budget-stop", result: "insufficient-budget",
    startedMs: 16701, endedMs: 16701, remainingMs: 1299, component: null, windowId: null });
  assert.equal(isCaptureReadiness(d), true);
});

test("observation error and cancellation preserve original throw without raw payloads", async () => {
  let ms = 10;
  const r = createCaptureReadiness(18000, () => ms);
  const reason = Error("private exception payload");
  await assert.rejects(r.observe("foreground", async () => { ms = 20; throw reason; }), error => error === reason);
  assert.equal(r.snapshot().observations?.entries[0].result, "error");
  assert.equal(JSON.stringify(r.snapshot()).includes("private"), false);
  const controller = new AbortController(); controller.abort(reason);
  await assert.rejects(r.observe("poll-wait", async () => controller.signal.throwIfAborted()), error => error === reason);
  assert.equal(r.snapshot().phase, "foreground");
  assert.equal(r.snapshot().treeReadCount, 0);
});

test("bounded observation history survives saved attempt copies and old diagnostics remain valid", async () => {
  let ms = 0;
  const r = createCaptureReadiness(18000, () => ms);
  for (let i = 0; i < 100; i++) await r.observe("foreground", async () => { ms++; }, () => ({ result: "match" }));
  const d = r.snapshot("failed");
  assert.equal(d.observations?.totalCount, 100);
  assert.equal(d.observations?.droppedCount, 36);
  assert.equal(d.observations?.entries.length, 64);
  assert.equal(d.observations?.entries[0].endedMs, 1);
  assert.equal(d.observations?.entries[1].endedMs, 38);
  assert.equal(isCaptureReadiness(d), true);
  const attempts = recordCaptureAttempt([], { ...snapshot(), captureReadiness: d }, 1, 0, 100);
  d.observations!.entries[0].endedMs = 0;
  assert.equal(attempts[0].readiness?.observations?.entries[0].endedMs, 1);
  assert.equal(isCaptureRequestDiagnostics({ totalDurationMs: 100, totalAttempts: 1, droppedAttempts: 0, attempts }), true);
  const old = { ...r.snapshot(), observations: undefined };
  assert.equal(isCaptureReadiness(old), true);
});

test("malformed observation intervals, budgets, counts and payload enums are rejected", async () => {
  let ms = 0;
  const r = createCaptureReadiness(18000, () => ms);
  await r.observe("foreground", async () => { ms = 10; });
  const d = r.snapshot();
  const row = d.observations!.entries[0];
  for (const entries of [[{ ...row, startedMs: 11 }], [{ ...row, remainingMs: 18000 }],
    [{ ...row, kind: "pixels" }], [{ ...row, result: "authorized" }], [{ ...row, windowId: {} }],
    [{ ...row, kind: "budget-stop" }], [{ ...row, result: "insufficient-budget" }]]) {
    assert.equal(isCaptureReadiness({ ...d, observations: { totalCount: 1, droppedCount: 0, entries } }), false);
  }
  for (const o of [null, [], { totalCount: 2, droppedCount: 0, entries: [row] },
    { totalCount: 1, droppedCount: 1, entries: [row] }]) {
    assert.equal(isCaptureReadiness({ ...d, observations: o }), false);
  }
});
