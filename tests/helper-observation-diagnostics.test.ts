import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { getHelperRecoveryEvidence, isFreshHelperRecoveryEvidence, isHelperObservationEvidence } from "../shared/helper-observation";
import { hasTransientHelperDiagnostics, helperObservationDiagnosticCodes, parseHelperObservationDiagnostics } from "../shared/helper-observation-diagnostics";
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
