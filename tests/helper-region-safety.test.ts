import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { hasCompleteHelperObservationEvidence, hasSafeHelperObservationContext, hasActionableHelperEvidence, helperRegionSafety,
  helperTapSafetyBounds, helperNodeRegionSafety, hasSafeHelperBackEvidence, type HelperWindowEvidence } from "../shared/helper-observation";
import { resolveParentTap } from "../electron/automation/debug-target-resolution";
import { inspectScrollTree } from "../electron/automation/debug-scroll-execution";
import { scrollUntilInput } from "../shared/debug-protocol";
import { evaluateDebugTaskConditions } from "../shared/debug-task-checker";
import type { DebugTaskEvidence } from "../shared/debug-task";
import type { UiSnapshot } from "../shared/types";
import { helperEvidenceSnapshot } from "./fixtures/helper-evidence";

const addWindow = (snapshot: UiSnapshot, overrides: Partial<HelperWindowEvidence> = {}) => {
  const window: HelperWindowEvidence = { id: "8", type: "system", layer: 2, active: false, focused: false,
    bounds: { x: 0, y: 0, width: 100, height: 10 }, packageName: "com.android.systemui", rootAvailable: true, ...overrides };
  snapshot.helperObservation!.windowsBefore.push(window);
  snapshot.helperObservation!.windowsAfter.push(structuredClone(window));
};
const middle = { left: 30, top: 40, right: 70, bottom: 100 };

test("complete Helper observations allow safe content regions despite status/nav bars and an unrelated floating control", () => {
  const snapshot = helperEvidenceSnapshot();
  addWindow(snapshot);
  addWindow(snapshot, { id: "9", bounds: { x: 0, y: 190, width: 100, height: 10 } });
  addWindow(snapshot, { id: "10", bounds: { x: 85, y: 120, width: 15, height: 15 } });
  assert.equal(hasCompleteHelperObservationEvidence(snapshot), true);
  assert.equal(hasSafeHelperObservationContext(snapshot), true);
  assert.equal(hasActionableHelperEvidence(snapshot), false, "legacy whole-window check remains conservative");
  assert.equal(helperRegionSafety(snapshot, middle), "clear");
  assert.equal(helperRegionSafety(snapshot, { left: 85, top: 120, right: 90, bottom: 125 }), "occluded");
  assert.equal(helperRegionSafety(snapshot, { left: 0, top: 0, right: 100, bottom: 11 }), "occluded");
});

test("regional checks never whitelist system, IME or overlay windows and honor ordering only with complete window evidence", () => {
  for (const type of ["system", "input_method", "accessibility_overlay", "application", "split_screen_divider"] as const) {
    for (const layer of [0, 1, 2]) {
      const snapshot = helperEvidenceSnapshot(); addWindow(snapshot, { type, layer, bounds: { x: 30, y: 40, width: 40, height: 60 } });
      assert.equal(helperRegionSafety(snapshot, middle), layer < 1 ? "clear" : "occluded");
    }
  }
  for (const flags of [{ type: "unknown" as const }, { active: true }, { focused: true }, { rootAvailable: false }]) {
    const snapshot = helperEvidenceSnapshot(); addWindow(snapshot, { ...flags, layer: 0 });
    assert.equal(helperRegionSafety(snapshot, middle), "unknown");
    assert.equal(hasSafeHelperBackEvidence(snapshot), false);
  }
});

test("regions reject missing, fractional, infinite, empty, offscreen and out-of-window geometry", () => {
  const snapshot = helperEvidenceSnapshot();
  for (const region of [null, undefined, { ...middle, left: NaN }, { ...middle, top: 0.5 }, { ...middle, right: Infinity },
    { ...middle, right: 30 }, { ...middle, left: -1 }, { ...middle, right: 101 }, { ...middle, bottom: 201 }])
    assert.equal(helperRegionSafety(snapshot, region), "unknown");
  assert.equal(helperTapSafetyBounds(snapshot, 100, 10), null);
  assert.equal(helperTapSafetyBounds(snapshot, 50.5, 10), null);
  assert.deepEqual(helperTapSafetyBounds(snapshot, 0, 0), { left: 0, top: 0, right: 25, bottom: 25 });
  const bounds = "[20,20][80,180]";
  snapshot.root!.bounds = { left: 20, top: 20, right: 80, bottom: 180, raw: bounds };
  for (const key of ["bounds", "bounds-screen", "visible-bounds"]) snapshot.root!.attributes![key] = bounds;
  for (const windows of [snapshot.helperObservation!.windowsBefore, snapshot.helperObservation!.windowsAfter])
    windows[0].bounds = { x: 20, y: 20, width: 60, height: 160 };
  assert.equal(hasSafeHelperObservationContext(snapshot), true);
  assert.equal(helperRegionSafety(snapshot, helperTapSafetyBounds(snapshot, 21, 60)), "unknown", "screen clamp must not shrink across the app window");
});

test("Back follows unique authorized focus but rejects input methods, accessibility overlays and competing apps", () => {
  const bars = helperEvidenceSnapshot(); addWindow(bars);
  assert.equal(hasSafeHelperBackEvidence(bars), true);
  for (const type of ["input_method", "accessibility_overlay", "application", "unknown"] as const) {
    const snapshot = helperEvidenceSnapshot(); addWindow(snapshot, { type });
    assert.equal(hasSafeHelperBackEvidence(snapshot), false);
  }
  const changed = helperEvidenceSnapshot(); addWindow(changed);
  changed.helperObservation!.windowsAfter[1].bounds.x++;
  assert.equal(hasSafeHelperObservationContext(changed), false, "window movement during capture invalidates evidence");
});

test("task assertions can use clear regions; a covered candidate is insufficient for every state, including absent", () => {
  const evidence = (time: number): DebugTaskEvidence => {
    const snapshot = helperEvidenceSnapshot({ startedAt: time });
    const raw = "[30,40][70,100]";
    snapshot.root!.bounds = { ...middle, raw };
    for (const key of ["bounds", "bounds-screen", "visible-bounds"]) snapshot.root!.attributes![key] = raw;
    addWindow(snapshot);
    return { snapshot, observation: { snapshotId: randomUUID(), capturedAt: new Date(1_700_000_000_000 + time).toISOString(),
      component: "com.example.helper/.Main", windowId: "adb-window", activityRecordId: "activity" } };
  };
  const a = evidence(100), b = evidence(500);
  const evaluate = (state: "visible" | "enabled" | "disabled" | "absent", text = "完成") =>
    evaluateDebugTaskConditions([{ id: "condition", selector: { text }, state }], a, b, "com.example.helper");
  assert.equal(evaluate("visible").status, "passed");
  assert.equal(evaluate("absent", "不存在").status, "passed");
  addWindow(b.snapshot, { id: "9", bounds: { x: 65, y: 90, width: 10, height: 20 } });
  for (const state of ["visible", "enabled", "disabled", "absent"] as const)
    assert.equal(evaluate(state).status, "insufficient_evidence");
});

test("explicit hidden nodes keep occlusion uncertainty without turning truly offscreen inverted bounds into visible regions", () => {
  const snapshot = helperEvidenceSnapshot(), node = snapshot.root!;
  node.visibleToUser = false; node.visibilityEvidence = "hidden"; node.attributes!["visible-to-user"] = "false";
  node.bounds = { left: 0, top: 0, right: 0, bottom: 0, raw: "[0,0][0,0]" };
  node.attributes!.bounds = node.attributes!["visible-bounds"] = "[0,0][0,0]";
  addWindow(snapshot);
  assert.equal(helperNodeRegionSafety(snapshot, node), "occluded");
  node.attributes!["bounds-screen"] = "[120,0][100,200]";
  assert.equal(helperNodeRegionSafety(snapshot, node), "clear");
});

test("clickable-parent tap protects both the actual parent touch point and its semantic anchor", () => {
  const snapshot = helperEvidenceSnapshot({ width: 400, height: 800 });
  const root = snapshot.root!, child = structuredClone(root);
  child.id = `${root.id}/0`; child.clickable = false; child.attributes!.clickable = "false";
  const raw = "[20,100][380,160]";
  child.bounds = { left: 20, top: 100, right: 380, bottom: 160, raw };
  for (const key of ["bounds", "bounds-screen", "visible-bounds"]) child.attributes![key] = raw;
  root.text = null; root.attributes!.text = ""; root.resourceId = "parent"; root.attributes!["resource-id"] = "parent";
  root.children = [child]; snapshot.nodeCount = 2;
  addWindow(snapshot);
  assert.equal(resolveParentTap(child, snapshot, snapshot, "com.example.helper").x, 200);
  for (const bounds of [{ x: 220, y: 400, width: 10, height: 10 }, { x: 350, y: 110, width: 10, height: 10 }]) {
    const covered = structuredClone(snapshot); addWindow(covered, { id: "9", bounds });
    assert.throws(() => resolveParentTap(child, snapshot, covered, "com.example.helper"), /遮挡/);
    assert.throws(() => resolveParentTap(child, covered, snapshot, "com.example.helper"), /遮挡/);
  }
});

test("shared scroll-tree analysis needs no PNG bytes and preserves nested clipping and marker occlusion", () => {
  const snapshot = helperEvidenceSnapshot({ width: 400, height: 800 });
  const root = snapshot.root!, parent = structuredClone(root), marker = structuredClone(root);
  const configure = (node: typeof root, id: string, rect: number[], text: string | null, resource: string, scrollable: boolean) => {
    node.id = id; node.text = text; node.resourceId = resource; node.scrollable = scrollable; node.clickable = false;
    Object.assign(node.attributes!, { text: text ?? "", "resource-id": resource, scrollable: String(scrollable), clickable: "false" });
    const [left, top, right, bottom] = rect, raw = `[${left},${top}][${right},${bottom}]`;
    node.bounds = { left, top, right, bottom, raw };
    for (const key of ["bounds", "bounds-screen", "visible-bounds"]) node.attributes![key] = raw;
  };
  configure(root, "0", [0, 0, 400, 800], null, "list", true);
  configure(parent, "0/0", [50, 50, 100, 100], null, "group", false);
  configure(marker, "0/0/0", [200, 200, 300, 250], "END", "end", false);
  root.children = [parent]; parent.children = [marker]; snapshot.nodeCount = 3;
  addWindow(snapshot);
  const input = scrollUntilInput.parse({ sessionId: randomUUID(), requestId: randomUUID(), backend: "accessibility-helper",
    target: { selector: { resourceId: "list" } }, direction: "down", until: { selector: { text: "END" } } });
  const inspect = () => inspectScrollTree(snapshot, input, "com.example.helper", root, "7");
  assert.equal(snapshot.screenshotDataUrl, null);
  assert.equal(hasSafeHelperObservationContext(snapshot), true);
  assert.equal(inspect().condition, null, "a descendant outside the intermediate window clip is not a completion marker");
  configure(marker, "0/0/0", [60, 60, 90, 90], "END", "end", false);
  assert.equal(inspect().condition, "target");
  addWindow(snapshot, { id: "9", bounds: { x: 65, y: 65, width: 5, height: 5 } });
  assert.throws(inspect, /遮挡/);
});
