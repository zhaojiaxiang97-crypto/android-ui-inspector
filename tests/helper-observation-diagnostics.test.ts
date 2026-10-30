import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { getHelperRecoveryEvidence, isFreshHelperRecoveryEvidence, isHelperObservationEvidence, type HelperRecoveryEvidence } from "../shared/helper-observation";
import { hasTransientHelperDiagnostics, hasWindowTransitionHelperDiagnostics, helperObservationDiagnosticCodes, parseHelperObservationDiagnostics } from "../shared/helper-observation-diagnostics";
import { helperEvidence, helperFrame, helperPackage } from "./fixtures/helper-protocol";

const diagnostics = () => ({ version: 1 as const, reasons: [{ code: "child_unavailable" as const, count: 1 }] });
const incomplete = (start = 200) => ({ ...helperEvidence(start), complete: false as const, diagnostics: diagnostics() });
const parse = (value: unknown) => getHelperRecoveryEvidence(value, helperPackage, helperFrame);

test("diagnostics retain only bounded closed codes and counts, never free text or arbitrary fields", () => {
  for (const code of helperObservationDiagnosticCodes) {
    assert.deepEqual(parseHelperObservationDiagnostics({ version: 1, reasons: [{ code, count: 10000 }] }),
      { version: 1, reasons: [{ code, count: 10000 }] });
  }
  for (const value of [null, {}, { ...diagnostics(), token: "secret" }, { version: 2, reasons: [] },
    { version: 1, reasons: [{ code: "private page title", count: 1 }] },
    { version: 1, reasons: [{ ...diagnostics().reasons[0], message: "secret" }] },
    { version: 1, reasons: [...diagnostics().reasons, ...diagnostics().reasons] },
    ...[0, -1, 0.5, 10001, Infinity, "1"].map(count => ({ version: 1, reasons: [{ code: "child_unavailable", count }] }))]) {
    assert.equal(parseHelperObservationDiagnostics(value), undefined);
    assert.equal(hasTransientHelperDiagnostics(value), false);
  }
  assert.equal(hasTransientHelperDiagnostics({ version: 1, reasons: [] }), false);
});

test("old complete evidence stays compatible; new complete evidence cannot carry failure reasons", () => {
  assert.equal(isHelperObservationEvidence(helperEvidence()), true);
  assert.equal(isHelperObservationEvidence({ ...helperEvidence(), diagnostics: { version: 1, reasons: [] } }), true);
  assert.equal(isHelperObservationEvidence({ ...helperEvidence(), diagnostics: diagnostics() }), false);
  assert.equal(isHelperObservationEvidence({ ...helperEvidence(), diagnostics: { ...diagnostics(), arbitrary: "secret" } }), false);
});

test("a null child may justify read-only recovery; absence, mixed reasons and unknown exceptions may not", () => {
  assert.ok(parse(incomplete()));
  assert.equal(isHelperObservationEvidence(incomplete()), false, "failed metadata never becomes an accepted observation");
  assert.equal(parse({ ...helperEvidence(), complete: false }), undefined);
  assert.equal(parse({ ...incomplete(), diagnostics: { version: 1, reasons: [] } }), undefined);
  for (const code of helperObservationDiagnosticCodes.filter(code => !["child_unavailable", "window_inventory_changed"].includes(code))) {
    assert.equal(parse({ ...incomplete(), diagnostics: { version: 1, reasons: [...diagnostics().reasons, { code, count: 1 }] } }), undefined);
  }
});

test("inventory changes allow replacement authorized focus, but both inventories must be independently safe", () => {
  const changed = { ...incomplete(), diagnostics: { version: 1, reasons: [{ code: "window_inventory_changed", count: 1 }] } };
  changed.windowsAfter[0].id = "8";
  assert.ok(parse(changed));
  assert.equal(parse({ ...changed, windowsAfter: changed.windowsBefore }), undefined, "reason must explain a real inventory change");
  assert.equal(parse({ ...changed, diagnostics: diagnostics() }), undefined, "a changed inventory needs its explicit reason");
  for (const mutate of [
    (e: typeof changed) => { e.windowsBefore[0].rootAvailable = false; },
    (e: typeof changed) => { e.windowsAfter[0].rootAvailable = false; },
    (e: typeof changed) => { e.windowsAfter.push(structuredClone(e.windowsAfter[0])); },
    (e: typeof changed) => { e.windowsAfter[0].focused = false; },
    (e: typeof changed) => { e.windowsAfter[0].active = false; },
    (e: typeof changed) => { e.windowsAfter[0].type = "unknown"; },
    (e: typeof changed) => { e.windowsAfter[0].packageName = "other.package"; },
    (e: typeof changed) => { e.windowsBefore[0].bounds.width = 0; },
    (e: typeof changed) => { e.windowsAfter[0].bounds.x = -1; },
    (e: typeof changed) => { e.windowsAfter[0].bounds.width = 11; },
    (e: typeof changed) => { e.windowsAfter.push({ ...e.windowsAfter[0], id: "9", focused: false }); },
  ]) {
    const next = structuredClone(changed); mutate(next); assert.equal(parse(next), undefined);
  }
});

test("recovery metadata rejects missing fields, extra fields, invalid timing, package or frame", () => {
  for (const mutate of [
    (e: Record<string, any>) => { delete e.windowId; },
    (e: Record<string, any>) => { e.extra = "private title"; },
    (e: Record<string, any>) => { e.timing.completedAtMs = 1; },
    (e: Record<string, any>) => { e.timing.completedAtMs = 40000; },
    (e: Record<string, any>) => { e.displayAfter.rotation = 1; },
    (e: Record<string, any>) => { e.packageName = "other.package"; },
    (e: Record<string, any>) => { e.serviceInstanceId = "not-uuid"; },
    (e: Record<string, any>) => { e.windowId = "8"; },
    (e: Record<string, any>) => { e.lossless = false; },
  ]) {
    const next = structuredClone(incomplete()); mutate(next); assert.equal(parse(next), undefined);
  }
});

test("every failed and successful read advances the same service, package and frame cursor", () => {
  const before = helperEvidence(100), failed = parse(incomplete(200))!, after = helperEvidence(300);
  assert.ok(isFreshHelperRecoveryEvidence(before, failed));
  assert.ok(isFreshHelperRecoveryEvidence(failed, after));
  const again = parse(incomplete(250))!;
  assert.ok(isFreshHelperRecoveryEvidence(failed, again));
  assert.equal(isFreshHelperRecoveryEvidence(failed, helperEvidence(200)), false);
  assert.equal(isFreshHelperRecoveryEvidence(failed, { ...after, captureId: failed.captureId }), false);
  assert.equal(isFreshHelperRecoveryEvidence(failed, { ...after, serviceInstanceId: randomUUID() }), false);
  const rotated = structuredClone(after); rotated.displayBefore.rotation = rotated.displayAfter.rotation = 1;
  assert.equal(isFreshHelperRecoveryEvidence(failed, rotated), false);
  assert.equal(isFreshHelperRecoveryEvidence(failed, { ...after, packageName: "other.package" }), false);
});

test("the observed inventory-change plus focus-invalid pair permits only an authorized start and unfocused ending inventory", () => {
  const changed = { ...incomplete(), diagnostics: { version: 1 as const,
    reasons: [{ code: "window_inventory_changed" as const, count: 1 }, { code: "focus_invalid" as const, count: 1 }] } };
  changed.windowsAfter[0].id = "8"; changed.windowsAfter[0].focused = false;
  assert.ok(hasWindowTransitionHelperDiagnostics(changed.diagnostics));
  assert.ok(parse(changed)); assert.equal(isHelperObservationEvidence(changed), false);
  assert.ok(isFreshHelperRecoveryEvidence(helperEvidence(100), parse(changed)!));
  assert.ok(isFreshHelperRecoveryEvidence(parse(changed)!, helperEvidence(300)));
  for (const mutate of [
    (e: Record<string, any>) => { e.diagnostics.reasons.pop(); },
    (e: Record<string, any>) => { e.diagnostics.reasons.shift(); },
    (e: Record<string, any>) => { e.diagnostics.reasons.push({ code: "child_unavailable", count: 1 }); },
    (e: Record<string, any>) => { e.windowsBefore[0].focused = false; },
    (e: Record<string, any>) => { e.windowsAfter[0].focused = true; },
    (e: Record<string, any>) => { e.windowsAfter[0].packageName = "com.foreign.app"; },
    (e: Record<string, any>) => { e.windowsAfter[0].rootAvailable = false; },
    (e: Record<string, any>) => { e.windowsAfter[0].type = "accessibility_overlay"; },
    (e: Record<string, any>) => { e.windowsAfter.push({ ...e.windowsAfter[0], id: "9" }); },
    (e: Record<string, any>) => { e.displayAfter.rotation = 1; },
    (e: Record<string, any>) => { e.packageName = ""; e.windowId = ""; },
  ]) { const next = structuredClone(changed); mutate(next); assert.equal(parse(next), undefined); }
});

function systemGap(start = 200) {
  const e: HelperRecoveryEvidence = incomplete(start);
  Object.assign(e, { packageName: "", windowId: "", diagnostics: { version: 1, reasons: [{ code: "focus_invalid", count: 1 }] } });
  const system = { ...e.windowsBefore[0], id: "91", type: "system" as const, packageName: "com.android.systemui", focused: false, active: false };
  e.windowsBefore = [system]; e.windowsAfter = structuredClone(e.windowsBefore);
  return e;
}

function windowMotion(start = 200): HelperRecoveryEvidence {
  const e: HelperRecoveryEvidence = incomplete(start);
  e.diagnostics = { version: 1, reasons: [{ code: "window_inventory_changed", count: 1 }] };
  e.windowsBefore[0].bounds = { x: -3, y: 0, width: 9, height: 20 };
  e.windowsAfter[0].bounds = { x: -1, y: 0, width: 9, height: 20 };
  const system = { ...structuredClone(e.windowsBefore[0]), id: "91", type: "system" as const, packageName: "com.android.systemui",
    active: false, focused: false, bounds: { x: 0, y: 0, width: 10, height: 1 } };
  const background = { ...structuredClone(system), id: "8", type: "application" as const, packageName: helperPackage };
  e.windowsBefore.push(system, background); e.windowsAfter.push(structuredClone(system), structuredClone(background));
  return e;
}

function fullscreenExpansion(start = 200): HelperRecoveryEvidence {
  const e: HelperRecoveryEvidence = incomplete(start);
  e.diagnostics = { version: 1, reasons: [{ code: "window_inventory_changed", count: 1 }] };
  e.displayBefore = { width: 1080, height: 2400, rotation: 0 }; e.displayAfter = { ...e.displayBefore };
  e.windowsBefore[0].bounds = { x: 304, y: 583, width: 852, height: 1812 };
  e.windowsAfter[0].bounds = { x: 0, y: 0, width: 1080, height: 2400 };
  const system = { ...structuredClone(e.windowsBefore[0]), id: "91", type: "system" as const, packageName: "com.android.systemui",
    active: false, focused: false, bounds: { x: 0, y: 0, width: 1080, height: 104 } };
  e.windowsBefore.push(system); e.windowsAfter.push(structuredClone(system));
  return e;
}

test("the measured same-window expansion to the full display is only a failed-read recovery candidate", () => {
  const e = fullscreenExpansion(), before = JSON.stringify(e);
  const candidate = getHelperRecoveryEvidence(e, helperPackage, e.displayBefore);
  assert.ok(candidate); assert.equal(candidate.complete, false); assert.equal(isHelperObservationEvidence(candidate), false);
  assert.equal(JSON.stringify(e), before);
  const full = (start: number) => {
    const result = helperEvidence(start); result.displayBefore = { ...e.displayBefore }; result.displayAfter = { ...e.displayAfter };
    result.windowsBefore = structuredClone(e.windowsAfter); result.windowsAfter = structuredClone(e.windowsAfter); return result;
  };
  assert.ok(isFreshHelperRecoveryEvidence(full(100), candidate, helperPackage));
  assert.ok(isFreshHelperRecoveryEvidence(candidate, full(300), helperPackage));
  assert.equal(isFreshHelperRecoveryEvidence(full(100), { ...candidate, serviceInstanceId: randomUUID() }, helperPackage), false);
  assert.equal(isFreshHelperRecoveryEvidence(candidate, full(100), helperPackage), false);
});

test("full-display expansion rejects intermediate resize, unsafe geometry, focus changes and any other window change", () => {
  for (const mutate of [
    (e: HelperRecoveryEvidence) => { e.windowsAfter[0].bounds.width--; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[0].bounds.height--; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[0].bounds.y = 1; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[0].bounds.x = 1; },
    (e: HelperRecoveryEvidence) => { [e.windowsBefore, e.windowsAfter] = [e.windowsAfter, e.windowsBefore]; },
    (e: HelperRecoveryEvidence) => { e.windowsBefore[0].bounds.x = 1080; },
    (e: HelperRecoveryEvidence) => { e.windowsBefore[0].bounds.x = -852; },
    (e: HelperRecoveryEvidence) => { e.windowsBefore[0].bounds.y = -1; },
    (e: HelperRecoveryEvidence) => { e.windowsBefore[0].bounds.height = 2400; },
    (e: HelperRecoveryEvidence) => { e.windowsBefore[0].bounds.width = 1081; },
    (e: HelperRecoveryEvidence) => { e.windowsBefore[0].bounds.width = 0; },
    (e: HelperRecoveryEvidence) => { e.windowsBefore[0].bounds.x = Number.MAX_SAFE_INTEGER; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[0].packageName = "com.foreign.app"; },
    (e: HelperRecoveryEvidence) => { e.packageName = "com.foreign.app"; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[0].focused = false; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[0].active = false; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[0].id = "8"; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[0].layer++; },
    (e: HelperRecoveryEvidence) => { e.windowsBefore[0].rootAvailable = false; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[1].bounds.height++; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[1].focused = true; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[1].layer++; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter.push({ ...e.windowsAfter[1], id: "92", type: "input_method" }); },
    (e: HelperRecoveryEvidence) => { e.windowsAfter.push({ ...e.windowsAfter[1], id: "92", type: "application", packageName: "com.foreign.app" }); },
    (e: HelperRecoveryEvidence) => { e.displayAfter.rotation = 1; },
    (e: HelperRecoveryEvidence) => { e.diagnostics.reasons.push({ code: "focus_invalid", count: 1 }); },
  ]) {
    const e = fullscreenExpansion(); mutate(e); assert.equal(getHelperRecoveryEvidence(e, helperPackage, e.displayBefore), undefined);
  }
});

test("only the same authorized focused window may translate horizontally while partly offscreen", () => {
  const raw = windowMotion(), original = JSON.stringify(raw), motion = parse(raw)!;
  assert.ok(motion); assert.equal(JSON.stringify(raw), original); assert.equal(isHelperObservationEvidence(raw), false);
  assert.equal(motion.windowsBefore[0].bounds.x, -3); assert.equal(motion.windowsAfter[0].bounds.x, -1);
  assert.ok(isFreshHelperRecoveryEvidence(helperEvidence(100), motion, helperPackage));
  assert.ok(isFreshHelperRecoveryEvidence(motion, parse(windowMotion(250))!, helperPackage));
  assert.ok(isFreshHelperRecoveryEvidence(motion, helperEvidence(300), helperPackage));
  assert.equal(isFreshHelperRecoveryEvidence(motion, { ...helperEvidence(300), serviceInstanceId: randomUUID() }, helperPackage), false);
  assert.equal(isFreshHelperRecoveryEvidence(motion, helperEvidence(200), helperPackage), false);
  assert.equal(isFreshHelperRecoveryEvidence(motion, { ...helperEvidence(300), captureId: motion.captureId }, helperPackage), false);
  assert.equal(parse({ ...raw, packageName: "com.foreign.app" }), undefined);
  const inside = windowMotion(); inside.windowsBefore[0].bounds.x = 0; inside.windowsAfter[0].bounds.x = 1;
  assert.ok(parse(inside), "the same strict motion rule also covers an in-screen translation");
});

test("window motion rejects other field changes, system/background movement, resize and unsafe clipping", () => {
  for (const mutate of [
    (e: HelperRecoveryEvidence) => { e.diagnostics.reasons.push({ code: "child_unavailable", count: 1 }); },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[0].bounds.y = 1; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[0].bounds.width = 8; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[0].bounds.height = 19; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[0].bounds.x = -9; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[0].bounds.x = 10; },
    (e: HelperRecoveryEvidence) => { e.windowsBefore[0].bounds.width = e.windowsAfter[0].bounds.width = 11; },
    (e: HelperRecoveryEvidence) => { e.windowsBefore[0].rootAvailable = false; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[0].rootAvailable = false; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[0].type = "system"; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[0].focused = false; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[0].active = false; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[0].layer++; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[0].packageName = "com.foreign.app"; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[1].bounds = { x: 1, y: 0, width: 9, height: 1 }; },
    (e: HelperRecoveryEvidence) => { e.windowsBefore[0].bounds.x = e.windowsAfter[0].bounds.x = 0;
      e.windowsAfter[1].bounds = { x: 1, y: 0, width: 9, height: 1 }; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[2].bounds = { x: 1, y: 0, width: 9, height: 1 }; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[1].layer++; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[1].type = "input_method"; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[1].type = "accessibility_overlay"; },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[2].packageName = "com.foreign.app"; },
    (e: HelperRecoveryEvidence) => { e.windowsBefore[0].bounds.x = 0; e.windowsAfter[0].bounds.x = 1;
      e.windowsAfter.push({ ...e.windowsAfter[2], id: "92", packageName: "com.foreign.app" }); },
    (e: HelperRecoveryEvidence) => { e.windowsBefore[0].bounds.x = 0; e.windowsAfter[0].bounds.x = 1;
      e.windowsAfter.push({ ...e.windowsAfter[2], id: "92", type: "input_method" }); },
    (e: HelperRecoveryEvidence) => { e.windowsAfter[1].id = "7"; },
    (e: HelperRecoveryEvidence) => { e.displayAfter.rotation = 1; },
  ]) { const e = windowMotion(); mutate(e); assert.equal(parse(e), undefined); }
});

test("the measured system-only gap preserves empty identities and needs an existing explicit package after the gap", () => {
  const raw = systemGap(), untouched = JSON.stringify(raw), gap = parse(raw)!;
  assert.ok(gap); assert.equal(gap.packageName, ""); assert.equal(gap.windowId, ""); assert.equal(JSON.stringify(raw), untouched);
  assert.equal(isHelperObservationEvidence(raw), false);
  assert.ok(isFreshHelperRecoveryEvidence(helperEvidence(100), gap, helperPackage));
  assert.equal(isFreshHelperRecoveryEvidence(gap, helperEvidence(300)), false, "never infer the missing anchor from the next frame");
  assert.ok(isFreshHelperRecoveryEvidence(gap, helperEvidence(300), helperPackage));
  assert.ok(isFreshHelperRecoveryEvidence(gap, parse(systemGap(250))!, helperPackage));
  assert.equal(isFreshHelperRecoveryEvidence(gap, { ...parse(systemGap(250))!, captureId: gap.captureId }, helperPackage), false);
  assert.equal(isFreshHelperRecoveryEvidence(gap, { ...parse(systemGap(250))!, serviceInstanceId: randomUUID() }, helperPackage), false);
  assert.equal(isFreshHelperRecoveryEvidence(gap, helperEvidence(200), helperPackage), false);
  assert.equal(isFreshHelperRecoveryEvidence(gap, { ...helperEvidence(300), packageName: "com.foreign.app" }, helperPackage), false);
  assert.equal(isFreshHelperRecoveryEvidence(gap, { ...helperEvidence(300), serviceInstanceId: randomUUID() }, helperPackage), false);
});

test("a system-only inventory may bracket authorized focus in either direction only with both matching diagnostics", () => {
  for (const startingWithGap of [false, true]) {
    const e = systemGap(); e.diagnostics = { version: 1, reasons: [{ code: "window_inventory_changed", count: 1 }, { code: "focus_invalid", count: 1 }] };
    const app = helperEvidence(200);
    if (startingWithGap) e.windowsAfter = app.windowsAfter;
    else { e.packageName = helperPackage; e.windowId = "7"; e.windowsBefore = app.windowsBefore; }
    assert.ok(parse(e));
    const foreign = structuredClone(e);
    (startingWithGap ? foreign.windowsAfter : foreign.windowsBefore)[0].packageName = "com.foreign.app";
    assert.equal(parse(foreign), undefined);
    const ime = structuredClone(e);
    (startingWithGap ? ime.windowsBefore : ime.windowsAfter)[0].type = "input_method";
    assert.equal(parse(ime), undefined);
  }
});

test("system-only gap metadata rejects unsafe windows, unexplained inventory changes, identity guessing and mixed reasons", () => {
  for (const mutate of [
    (e: Record<string, any>) => { e.windowsBefore[0].active = true; },
    (e: Record<string, any>) => { e.windowsAfter[0].focused = true; },
    (e: Record<string, any>) => { e.windowsAfter[0].rootAvailable = false; },
    (e: Record<string, any>) => { e.windowsAfter[0].type = "application"; },
    (e: Record<string, any>) => { e.windowsAfter[0].type = "accessibility_overlay"; },
    (e: Record<string, any>) => { e.windowsAfter[0].type = "input_method"; },
    (e: Record<string, any>) => { e.windowsAfter[0].type = "unknown"; },
    (e: Record<string, any>) => { e.windowsAfter[0].bounds.width = 11; },
    (e: Record<string, any>) => { e.windowsAfter[0].id = "92"; },
    (e: Record<string, any>) => { e.packageName = helperPackage; e.windowId = "7"; },
    (e: Record<string, any>) => { e.diagnostics.reasons.push({ code: "window_inventory_changed", count: 1 }); },
    (e: Record<string, any>) => { e.diagnostics.reasons.push({ code: "child_unavailable", count: 1 }); },
    (e: Record<string, any>) => { e.displayAfter.rotation = 1; },
  ]) { const e = systemGap(); mutate(e); assert.equal(parse(e), undefined); }
});
