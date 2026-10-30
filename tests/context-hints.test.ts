import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTEXT_HINTS, DEFAULT_CONTEXT_HINTS, MAX_CONTEXT_HINT_PREFERENCE_LENGTH, clearContextHint, dismissContextHint,
  markContextHintShown, newContextHintSession, parseContextHintPreference, readContextHintPreference,
  requestContextHint } from "../shared/context-hints";

test("valid hint preferences round trip without sharing input arrays", () => {
  const original = { version: 1, acknowledged: ["quick-select", "layer-focus", "quick-select"] };
  const parsed = parseContextHintPreference(original)!;
  assert.deepEqual(parsed, { version: 1, acknowledged: ["quick-select", "layer-focus"] });
  original.acknowledged.splice(0, original.acknowledged.length);
  assert.equal(parsed.acknowledged.length, 2);
  assert.deepEqual(readContextHintPreference(JSON.stringify(parsed)), parsed);
  assert.deepEqual(parseContextHintPreference({ version: 1, acknowledged: CONTEXT_HINTS.map(hint => hint.id) })?.acknowledged, CONTEXT_HINTS.map(hint => hint.id));
});

test("invalid, unknown and future preferences fall back as a whole", () => {
  for (const value of [null, false, [], {}, { version: 2, acknowledged: [] }, { version: "1", acknowledged: [] },
    { version: 1, acknowledged: null }, { version: 1, acknowledged: {} }, { version: 1, acknowledged: [null] },
    { version: 1, acknowledged: ["quick-select", "future"] }, { version: 1, acknowledged: ["__proto__"] },
    { version: 1, acknowledged: [" layer-focus"] }, { version: 1, acknowledged: ["layer-focus", "layer-focus", "layer-focus", "layer-focus"] }]) {
    assert.equal(parseContextHintPreference(value), null, JSON.stringify(value));
    assert.deepEqual(readContextHintPreference(JSON.stringify(value)), DEFAULT_CONTEXT_HINTS);
  }
});

test("corrupt or oversized storage is bounded before parsing", () => {
  for (const raw of [null, "", "[", '{"version":1,"acknowledged":[}', " ".repeat(MAX_CONTEXT_HINT_PREFERENCE_LENGTH + 1),
    JSON.stringify({ version: 1, acknowledged: [], extra: "x".repeat(MAX_CONTEXT_HINT_PREFERENCE_LENGTH) })]) {
    assert.deepEqual(readContextHintPreference(raw), DEFAULT_CONTEXT_HINTS);
  }
  const cyclic: { version: 1; acknowledged: never[]; self?: unknown } = { version: 1, acknowledged: [] };
  cyclic.self = cyclic;
  assert.equal(parseContextHintPreference(cyclic), null);
  assert.equal(parseContextHintPreference({ get version() { throw new Error("storage"); }, acknowledged: [] }), null);
});

test("waiting requests preserve the first candidate without consuming the session", () => {
  const session = newContextHintSession();
  const requested = requestContextHint(session, DEFAULT_CONTEXT_HINTS, "quick-select");
  assert.deepEqual(session, { pending: null, shown: null });
  assert.deepEqual(requested, { pending: "quick-select", shown: null });
  assert.equal(requestContextHint(requested, DEFAULT_CONTEXT_HINTS, "layer-focus"), requested);
  assert.equal(markContextHintShown(requested, "layer-focus"), requested);
});

test("only a displayed hint can be remembered by closing it", () => {
  const waiting = requestContextHint(newContextHintSession(), DEFAULT_CONTEXT_HINTS, "quick-select");
  const cancelled = dismissContextHint(waiting, DEFAULT_CONTEXT_HINTS, "quick-select");
  assert.deepEqual(cancelled.session, { pending: null, shown: null });
  assert.equal(cancelled.preference, DEFAULT_CONTEXT_HINTS);
  const shown = markContextHintShown(waiting, "quick-select");
  const closed = dismissContextHint(shown, DEFAULT_CONTEXT_HINTS, "quick-select");
  assert.deepEqual(closed.session, { pending: null, shown: "quick-select" });
  assert.deepEqual(closed.preference, { version: 1, acknowledged: ["quick-select"] });
  assert.deepEqual(DEFAULT_CONTEXT_HINTS, { version: 1, acknowledged: [] });
});

test("a displayed hint blocks every other hint for the rest of that session", () => {
  const shown = markContextHintShown(requestContextHint(newContextHintSession(), DEFAULT_CONTEXT_HINTS, "layer-focus"), "layer-focus");
  for (const hint of CONTEXT_HINTS) assert.equal(requestContextHint(shown, DEFAULT_CONTEXT_HINTS, hint.id), shown);
  const closed = dismissContextHint(shown, DEFAULT_CONTEXT_HINTS, "layer-focus");
  for (const hint of CONTEXT_HINTS) assert.equal(requestContextHint(closed.session, closed.preference, hint.id), closed.session);
});

test("acknowledged hints stay silent in fresh sessions while another hint can appear", () => {
  const shown = markContextHintShown(requestContextHint(newContextHintSession(), DEFAULT_CONTEXT_HINTS, "layer-focus"), "layer-focus");
  const { preference } = dismissContextHint(shown, DEFAULT_CONTEXT_HINTS, "layer-focus");
  const fresh = newContextHintSession();
  assert.equal(requestContextHint(fresh, preference, "layer-focus"), fresh);
  assert.deepEqual(requestContextHint(fresh, preference, "pinned-measurement"), { pending: "pinned-measurement", shown: null });
});

test("stale callbacks cannot remember another candidate and an unseen hint remains eligible", () => {
  const waiting = requestContextHint(newContextHintSession(), DEFAULT_CONTEXT_HINTS, "pinned-measurement");
  assert.deepEqual(dismissContextHint(waiting, DEFAULT_CONTEXT_HINTS, "quick-select"), { session: waiting, preference: DEFAULT_CONTEXT_HINTS });
  const fresh = newContextHintSession();
  assert.equal(markContextHintShown(fresh, "pinned-measurement"), fresh);
  assert.equal(requestContextHint(fresh, DEFAULT_CONTEXT_HINTS, "pinned-measurement").pending, "pinned-measurement");
});

test("ending an operation withdraws its unseen hint so the next relevant operation remains eligible", () => {
  const waiting = requestContextHint(newContextHintSession(), DEFAULT_CONTEXT_HINTS, "quick-select");
  assert.equal(clearContextHint(waiting, "layer-focus"), waiting);
  const cleared = clearContextHint(waiting, "quick-select");
  assert.deepEqual(cleared, { pending: null, shown: null });
  assert.deepEqual(requestContextHint(cleared, DEFAULT_CONTEXT_HINTS, "layer-focus"), { pending: "layer-focus", shown: null });
  assert.equal(markContextHintShown(cleared, "quick-select"), cleared);
});

test("ending an operation after its hint appeared keeps the one-hint session budget", () => {
  const shown = markContextHintShown(requestContextHint(newContextHintSession(), DEFAULT_CONTEXT_HINTS, "pinned-measurement"), "pinned-measurement");
  const cleared = clearContextHint(shown, "pinned-measurement");
  assert.deepEqual(cleared, { pending: null, shown: "pinned-measurement" });
  for (const hint of CONTEXT_HINTS) assert.equal(requestContextHint(cleared, DEFAULT_CONTEXT_HINTS, hint.id), cleared);
});

test("automatic hint cleanup neither acknowledges an operation nor clears existing user memory", () => {
  const preference = parseContextHintPreference({ version: 1, acknowledged: ["quick-select"] })!;
  const shown = markContextHintShown(requestContextHint(newContextHintSession(), preference, "layer-focus"), "layer-focus");
  const cleared = clearContextHint(shown, "layer-focus");
  const staleClose = dismissContextHint(cleared, preference, "layer-focus");
  assert.equal(staleClose.preference, preference);
  assert.deepEqual(preference.acknowledged, ["quick-select"]);
  const fresh = newContextHintSession();
  assert.equal(requestContextHint(fresh, preference, "quick-select"), fresh);
  assert.equal(requestContextHint(fresh, preference, "layer-focus").pending, "layer-focus");
});
