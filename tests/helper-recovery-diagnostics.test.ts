import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { assessHelperRecoveryEvidence, getHelperRecoveryEvidence, helperRecoverySourceReason, isFreshHelperRecoveryEvidence,
  type HelperRecoveryEvidence } from "../shared/helper-observation";
import { parseHelperRecoveryDiagnostics, type HelperRecoveryCandidateReason } from "../shared/helper-recovery-diagnostics";
import { HelperCaptureError } from "../electron/capture/accessibility-helper";
import { readHelperObservation } from "../electron/capture/helper-observation";
import { helperEvidence, helperFrame, helperPackage, helperPayload, helperToken } from "./fixtures/helper-protocol";

const incomplete = (): HelperRecoveryEvidence => ({ ...helperEvidence(200), complete: false,
  diagnostics: { version: 1, reasons: [{ code: "child_unavailable", count: 1 }] } });
const transition = (e: HelperRecoveryEvidence) => {
  e.diagnostics.reasons = [{ code: "window_inventory_changed", count: 1 }, { code: "focus_invalid", count: 1 }];
};
const motion = (e: HelperRecoveryEvidence) => {
  e.diagnostics.reasons = [{ code: "window_inventory_changed", count: 1 }];
  e.windowsBefore[0].bounds = { x: -3, y: 0, width: 9, height: 20 };
  e.windowsAfter[0].bounds = { x: -1, y: 0, width: 9, height: 20 };
};

test("every rejected candidate branch has a fixed reason and never becomes a complete observation", () => {
  const cases: [HelperRecoveryCandidateReason, (e: HelperRecoveryEvidence) => void][] = [
    ["metadata_invalid", e => { Object.assign(e, { privatePage: "never retain this" }); }],
    ["display_mismatch", e => { e.displayAfter.rotation = 1; }],
    ["motion_context_invalid", e => { motion(e); e.diagnostics.reasons.push({ code: "child_unavailable", count: 1 }); }],
    ["motion_focus_missing", e => { motion(e); e.windowId = "8"; }],
    ["motion_not_horizontal", e => { motion(e); e.windowsAfter[0].bounds.y = 1; }],
    ["motion_inventory_invalid", e => { motion(e); e.windowsBefore[0].rootAvailable = false; }],
    ["motion_other_fields_changed", e => { motion(e); e.windowsAfter[0].layer++; }],
    ["inventory_before_invalid", e => { e.windowsBefore[0].rootAvailable = false; }],
    ["inventory_after_invalid", e => { e.windowsAfter[0].rootAvailable = false; }],
    ["system_gap_invalid", e => { e.diagnostics.reasons = [{ code: "focus_invalid", count: 1 }]; }],
    ["empty_identity_transition_invalid", e => { transition(e); e.packageName = ""; e.windowId = ""; }],
    ["diagnostics_not_transient", e => { e.diagnostics.reasons = [{ code: "capture_exception", count: 1 }]; }],
    ["identity_mismatch", e => { e.packageName = "private.other.package"; }],
    ["focus_before_invalid", e => { e.windowsBefore[0].focused = false; }],
    ["focus_after_invalid", e => { e.windowsAfter[0].focused = false; }],
    ["transition_focus_after_invalid", e => { transition(e); }],
    ["focused_id_mismatch", e => { e.windowId = "8"; }],
    ["inventory_claim_mismatch", e => { e.diagnostics.reasons = [{ code: "window_inventory_changed", count: 1 }]; }],
  ];
  for (const [expected, mutate] of cases) {
    const raw = incomplete(); mutate(raw);
    const { evidence, diagnostics } = assessHelperRecoveryEvidence(raw, helperPackage, helperFrame);
    assert.equal(evidence, undefined, expected); assert.equal(diagnostics.candidate, expected);
    assert.equal(getHelperRecoveryEvidence(raw, helperPackage, helperFrame), undefined);
    assert.deepEqual(parseHelperRecoveryDiagnostics(diagnostics), diagnostics);
    const serialized = JSON.stringify(diagnostics);
    for (const forbidden of [helperPackage, "private.other.package", "never retain this", raw.captureId, raw.serviceInstanceId])
      assert.ok(!serialized.includes(forbidden), expected);
  }
  for (const mutate of [(_e: HelperRecoveryEvidence) => {}, motion, (e: HelperRecoveryEvidence) => {
    transition(e); e.windowsAfter[0].id = "8"; e.windowsAfter[0].focused = false;
  }]) {
    const raw = incomplete(); mutate(raw); const result = assessHelperRecoveryEvidence(raw, helperPackage, helperFrame);
    assert.equal(result.diagnostics.candidate, "accepted"); assert.equal(result.evidence!.complete, false);
    assert.deepEqual(result.evidence, getHelperRecoveryEvidence(raw, helperPackage, helperFrame));
  }
});

test("anonymous window differences distinguish movement, role and field changes without names or IDs", () => {
  const e = incomplete(); motion(e);
  e.windowsAfter[0].bounds.y = 1; e.windowsAfter[0].layer++; e.windowsAfter[0].packageName = "private.foreign.app";
  e.windowsAfter.push({ ...e.windowsAfter[0], id: "1234567", type: "input_method", active: false, focused: false });
  const result = assessHelperRecoveryEvidence(e, helperPackage, helperFrame);
  assert.deepEqual(result.diagnostics.windows!.changes[0], { kind: "changed", beforeRole: "authorized_application",
    afterRole: "other_application", fields: ["layer", "package", "x", "y"], beforeBounds: e.windowsBefore[0].bounds, afterBounds: e.windowsAfter[0].bounds });
  assert.equal(result.diagnostics.windows!.changes[1].afterRole, "input_method");
  assert.ok(!JSON.stringify(result.diagnostics).includes("1234567"));
  assert.ok(!JSON.stringify(result.diagnostics).includes("private.foreign.app"));
});

test("source reasons preserve the original service, package, display and monotonic freshness decisions", () => {
  const before = helperEvidence(100), next = helperEvidence(200);
  assert.equal(helperRecoverySourceReason(before, next), "accepted");
  for (const [reason, mutate] of [
    ["next_invalid", (e: typeof next) => { e.complete = false as true; }],
    ["package_changed", (e: typeof next) => { e.packageName = "other.app"; e.windowsBefore[0].packageName = e.windowsAfter[0].packageName = e.packageName; }],
    ["display_changed", (e: typeof next) => { e.displayBefore.rotation = e.displayAfter.rotation = 1; }],
    ["service_changed", (e: typeof next) => { e.serviceInstanceId = randomUUID(); }],
    ["capture_reused", (e: typeof next) => { e.captureId = before.captureId; }],
    ["capture_time_regressed", (e: typeof next) => { e.timing = helperEvidence(50).timing; }],
  ] as const) {
    const changed = structuredClone(next); mutate(changed);
    assert.equal(helperRecoverySourceReason(before, changed), reason); assert.equal(isFreshHelperRecoveryEvidence(before, changed), false);
  }
  assert.equal(helperRecoverySourceReason(before, next, ""), "package_anchor_missing");
  assert.equal(helperRecoverySourceReason({ ...before, complete: false } as unknown as typeof before, next), "previous_invalid");
});

test("transport gate reports schema, frame and inventory-count rejection before candidate assessment", async () => {
  for (const [expected, mutate] of [
    ["envelope_invalid", (p: Record<string, any>) => { p.xml = ""; p.privateText = "never retain private response"; }],
    ["display_mismatch", (p: Record<string, any>) => { p.rotation = 1; }],
    ["window_count_mismatch", (p: Record<string, any>) => { p.window_count = 2; }],
    ["failure_not_recoverable", (p: Record<string, any>) => { p.success = false; }],
    ["accepted", (p: Record<string, any>) => { p.helperObservation.windowsAfter[0].rootAvailable = false; }],
  ] as const) {
    const payload = { ...helperPayload("AAAA"), helperObservation: incomplete() }; mutate(payload);
    await assert.rejects(readHelperObservation(1234, helperToken, helperPackage, helperFrame, new AbortController().signal,
      (async () => new Response(JSON.stringify(payload))) as typeof fetch), error => {
      assert.ok(error instanceof HelperCaptureError); assert.equal(error.recoveryEvidence, undefined);
      assert.equal(error.recoveryDiagnostics!.transport, expected);
      assert.equal(error.recoveryDiagnostics!.candidate, expected === "accepted" ? "inventory_after_invalid" : undefined);
      if (expected === "envelope_invalid") assert.deepEqual(error.recoveryDiagnostics!.invalidSections, ["tree", "unknown_fields"]);
      assert.ok(!JSON.stringify(error.recoveryDiagnostics).includes("never retain")); return true;
    });
  }
});

test("diagnostics are immutable, closed and cannot grant recovery by claiming acceptance", () => {
  const error = new HelperCaptureError("helper-incomplete", "fixture", { recoveryDiagnostics: { version: 1, candidate: "accepted" } });
  assert.equal(error.recoveryEvidence, undefined); assert.ok(Object.isFrozen(error.recoveryDiagnostics));
  const mismatch = new HelperCaptureError("helper-incomplete", "fixture", { recoveryEvidence: incomplete(),
    diagnostics: { version: 1, reasons: [{ code: "window_inventory_changed", count: 1 }] } });
  assert.equal(mismatch.recoveryEvidence, undefined); assert.equal(mismatch.recoveryDiagnostics?.candidate, "diagnostics_mismatch");
  for (const value of [{ version: 1 }, { version: 2, candidate: "accepted" }, { version: 1, candidate: "private title" },
    { version: 1, candidate: "accepted", message: "secret" },
    { version: 1, candidate: "accepted", windows: { beforeCount: 100000, afterCount: 0, beforeFocusCount: 0,
      afterFocusCount: 0, beforeActiveCount: 0, afterActiveCount: 0, changes: [] } }])
    assert.equal(parseHelperRecoveryDiagnostics(value), undefined);
});

test("metadata schema failures identify only known field groups and never parser paths", () => {
  for (const [section, mutate] of [
    ["identity", (e: Record<string, any>) => { e.captureId = "private-id"; }],
    ["timing", (e: Record<string, any>) => { e.timing.completedAtMs = 0; }],
    ["windows", (e: Record<string, any>) => { e.windowsBefore[0].bounds.width = "private-value"; }],
    ["diagnostics", (e: Record<string, any>) => { e.diagnostics.reasons[0].message = "private-message"; }],
  ] as const) {
    const raw = incomplete(); mutate(raw); const result = assessHelperRecoveryEvidence(raw, helperPackage, helperFrame);
    assert.equal(result.evidence, undefined); assert.deepEqual(result.diagnostics.invalidSections, [section]);
    assert.ok(!JSON.stringify(result.diagnostics).includes("private"));
  }
});
