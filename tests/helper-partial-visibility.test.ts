import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { commonHelperPartialVisibilityRegion, createHelperNodePartialVisibility, hasSafeHelperObservationContext,
  helperNodePartialVisibility, helperNodeRegionSafety, type HelperPartialVisibilityResult, type HelperWindowEvidence } from "../shared/helper-observation";
import { evaluateDebugTaskConditions } from "../shared/debug-task-checker";
import { debugTaskCondition, type DebugTaskCondition, type DebugTaskEvidence } from "../shared/debug-task";
import type { ScreenRect } from "../shared/screen-coordinates";
import type { UiNode, UiSnapshot } from "../shared/types";
import { helperEvidenceSnapshot } from "./fixtures/helper-evidence";

const pkg = "com.example.helper", selector = { resourceId: `${pkg}:id/result` };
const addWindow = (snapshot: UiSnapshot, overrides: Partial<HelperWindowEvidence> = {}) => {
  const window: HelperWindowEvidence = { id: "8", type: "system", layer: 2, active: false, focused: false,
    bounds: { x: 0, y: 0, width: 100, height: 10 }, packageName: "com.android.systemui", rootAvailable: true, ...overrides };
  snapshot.helperObservation!.windowsBefore.push(window);
  snapshot.helperObservation!.windowsAfter.push(structuredClone(window));
};
const setRect = (node: UiNode, rect: ScreenRect) => {
  const raw = `[${rect.left},${rect.top}][${rect.right},${rect.bottom}]`;
  node.bounds = { ...rect, raw };
  for (const key of ["bounds", "bounds-screen", "visible-bounds"]) node.attributes![key] = raw;
};
const hide = (node: UiNode) => {
  node.visibleToUser = false; node.visibilityEvidence = "hidden"; node.attributes!["visible-to-user"] = "false";
  node.bounds = { left: 0, top: 0, right: 0, bottom: 0, raw: "[0,0][0,0]" };
  node.attributes!.bounds = node.attributes!["visible-bounds"] = "[0,0][0,0]";
};
const evidence = (time: number, configure?: (snapshot: UiSnapshot) => void): DebugTaskEvidence => {
  const snapshot = helperEvidenceSnapshot({ startedAt: time }); configure?.(snapshot);
  return { snapshot, observation: { snapshotId: randomUUID(), capturedAt: new Date(1_700_000_000_000 + time).toISOString(),
    component: `${pkg}/.Main`, windowId: "adb-window", activityRecordId: "activity" } };
};
const pair = (configure?: (snapshot: UiSnapshot) => void) => [evidence(100, configure), evidence(500, configure)] as const;
const evaluate = (a: DebugTaskEvidence, b: DebugTaskEvidence, overrides: Partial<DebugTaskCondition> = {}) =>
  evaluateDebugTaskConditions([{ id: "condition", selector, state: "visible", visibility: "partial", ...overrides }], a, b, pkg);
const area = (value: HelperPartialVisibilityResult) => value.regions.reduce((sum, r) => sum + (r.right - r.left) * (r.bottom - r.top), 0);

test("partial exposes common content behind bars and a floating window while default assertions stay strict", () => {
  const [a, b] = pair(snapshot => {
    addWindow(snapshot);
    addWindow(snapshot, { id: "9", bounds: { x: 0, y: 190, width: 100, height: 10 } });
    addWindow(snapshot, { id: "10", bounds: { x: 85, y: 120, width: 15, height: 15 } });
  });
  assert.equal(hasSafeHelperObservationContext(a.snapshot), true);
  assert.equal(helperNodeRegionSafety(a.snapshot, a.snapshot.root!), "occluded");
  const exposed = helperNodePartialVisibility(a.snapshot, a.snapshot.root!);
  assert.equal(exposed.status, "exposed"); assert.equal(area(exposed), 17775);
  assert.equal(evaluate(a, b).status, "passed");
  assert.equal(evaluate(a, b, { visibility: undefined }).status, "insufficient_evidence");
  assert.equal(evaluate(a, b, { state: "absent", visibility: undefined }).status, "insufficient_evidence");
  assert.equal(a.snapshot.screenshotDataUrl, null, "exported geometry needs no retained PNG bytes");
});

test("all covering windows are subtracted as a union; two partial covers can fully occlude", () => {
  const [a, b] = pair(snapshot => {
    addWindow(snapshot, { bounds: { x: 0, y: 0, width: 60, height: 200 } });
    addWindow(snapshot, { id: "9", bounds: { x: 40, y: 0, width: 60, height: 200 } });
  });
  assert.deepEqual(helperNodePartialVisibility(a.snapshot, a.snapshot.root!), { status: "occluded", regions: [] });
  assert.equal(evaluate(a, b).status, "failed");
  assert.equal(evaluate(a, b, { state: "absent", visibility: undefined }).status, "insufficient_evidence");
});

test("overlapping covers are not double counted and input order does not alter exposed area", () => {
  const snapshot = helperEvidenceSnapshot();
  addWindow(snapshot, { bounds: { x: 0, y: 0, width: 50, height: 150 } });
  addWindow(snapshot, { id: "9", bounds: { x: 25, y: 50, width: 75, height: 50 } });
  assert.equal(area(helperNodePartialVisibility(snapshot, snapshot.root!)), 10000);
  snapshot.helperObservation!.windowsBefore.reverse(); snapshot.helperObservation!.windowsAfter.reverse();
  assert.equal(area(helperNodePartialVisibility(snapshot, snapshot.root!)), 10000);
});

test("one pixel of common exposure is sufficient; touching edges are not an area", () => {
  const [a, b] = pair(snapshot => addWindow(snapshot, { bounds: { x: 0, y: 0, width: 100, height: 199 } }));
  setRect(a.snapshot.root!, { left: 99, top: 0, right: 100, bottom: 200 });
  setRect(b.snapshot.root!, { left: 99, top: 0, right: 100, bottom: 200 });
  assert.equal(area(helperNodePartialVisibility(a.snapshot, a.snapshot.root!)), 1);
  assert.equal(evaluate(a, b).status, "passed");
  const first: HelperPartialVisibilityResult = { status: "exposed", regions: [{ left: 0, top: 0, right: 1, bottom: 1 }] };
  const second: HelperPartialVisibilityResult = { status: "exposed", regions: [{ left: 1, top: 0, right: 2, bottom: 1 }] };
  assert.equal(commonHelperPartialVisibilityRegion(first, second), null);
});

test("equal and higher layers cover regardless of known window type; lower layers do not", () => {
  for (const type of ["system", "input_method", "accessibility_overlay", "application", "split_screen_divider"] as const)
    for (const layer of [0, 1, 2]) {
      const snapshot = helperEvidenceSnapshot();
      addWindow(snapshot, { type, layer, bounds: { x: 0, y: 0, width: 100, height: 200 } });
      assert.equal(helperNodePartialVisibility(snapshot, snapshot.root!).status, layer < 1 ? "exposed" : "occluded", `${type}/${layer}`);
    }
});

test("unknown, missing, competing or changed inventories never prove exposure or invisibility", () => {
  const cases: Array<(snapshot: UiSnapshot) => void> = [
    s => addWindow(s, { type: "unknown", layer: 0 }),
    s => addWindow(s, { rootAvailable: false }),
    s => addWindow(s, { active: true }),
    s => addWindow(s, { focused: true }),
    s => addWindow(s, { id: "7" }),
    s => { addWindow(s); s.helperObservation!.windowsAfter[1].bounds.x++; },
    s => { s.helperObservation!.displayAfter.rotation = 1; },
    s => { addWindow(s, { bounds: { x: Number.MAX_SAFE_INTEGER, y: 0, width: 2, height: 10 } }); },
    s => { s.helperObservation!.complete = false as true; },
    s => { for (let i = 8; i < 24; i++) addWindow(s, { id: String(i) }); },
    s => { s.root!.attributes!["visible-bounds"] = "missing"; },
  ];
  for (const change of cases) {
    const [a, b] = pair(change);
    assert.equal(helperNodePartialVisibility(a.snapshot, a.snapshot.root!).status, "unknown");
    assert.equal(evaluate(a, b).status, "insufficient_evidence");
  }
});

test("partial conservatively intersects every ancestor and does not accept a node outside that clip", () => {
  const snapshot = helperEvidenceSnapshot(), root = snapshot.root!, child = structuredClone(root);
  child.id = `${root.id}/0`; child.resourceId = "child"; child.attributes!["resource-id"] = "child";
  setRect(root, { left: 20, top: 20, right: 50, bottom: 50 });
  setRect(child, { left: 40, top: 40, right: 80, bottom: 80 });
  root.children = [child]; snapshot.nodeCount = 2;
  assert.equal(hasSafeHelperObservationContext(snapshot), true, "non-scroll parent is not clipped by the old tree validator");
  assert.deepEqual(helperNodePartialVisibility(snapshot, child).regions, [{ left: 40, top: 40, right: 50, bottom: 50 }]);
  setRect(child, { left: 60, top: 60, right: 80, bottom: 80 });
  assert.equal(helperNodePartialVisibility(snapshot, child).status, "occluded");
});

test("factory accepts only members of its validated tree and rejects duplicate node identity", () => {
  const snapshot = helperEvidenceSnapshot(), root = snapshot.root!;
  assert.equal(createHelperNodePartialVisibility(snapshot)(structuredClone(root)).status, "unknown");
  const child = structuredClone(root); root.children = [child]; snapshot.nodeCount = 2;
  assert.equal(helperNodePartialVisibility(snapshot, root).status, "unknown");
});

test("individually exposed frames need a shared positive region", () => {
  const [a, b] = pair();
  addWindow(a.snapshot, { bounds: { x: 50, y: 0, width: 50, height: 200 } });
  addWindow(b.snapshot, { bounds: { x: 0, y: 0, width: 50, height: 200 } });
  assert.equal(helperNodePartialVisibility(a.snapshot, a.snapshot.root!).status, "exposed");
  assert.equal(helperNodePartialVisibility(b.snapshot, b.snapshot.root!).status, "exposed");
  assert.equal(evaluate(a, b).status, "insufficient_evidence");
});

test("same identity may move with common exposure; changed identity is insufficient even for a matching selector", () => {
  const [a, b] = pair(); setRect(b.snapshot.root!, { left: 10, top: 10, right: 90, bottom: 190 });
  assert.equal(evaluate(a, b).status, "passed");
  for (const update of [
    (n: UiNode) => { n.id += "/changed"; },
    (n: UiNode) => { n.text = "changed"; n.attributes!.text = "changed"; },
    (n: UiNode) => { n.contentDesc = "changed"; n.attributes!["content-desc"] = "changed"; },
    (n: UiNode) => { n.className = "android.view.View"; n.attributes!.class = n.className; },
  ]) {
    const [x, y] = pair(); update(y.snapshot.root!);
    assert.equal(evaluate(x, y).status, "insufficient_evidence");
  }
});

test("duplicate exact matches include hidden nodes; missing and hidden matches do not prove absence", () => {
  const [a, b] = pair(snapshot => {
    const child = structuredClone(snapshot.root!); child.id += "/0"; hide(child);
    snapshot.root!.children = [child]; snapshot.nodeCount = 2;
  });
  const duplicate = evaluate(a, b); assert.equal(duplicate.status, "insufficient_evidence");
  assert.equal(duplicate.conditions[0].firstMatchCount, 2);
  const [hiddenA, hiddenB] = pair(snapshot => hide(snapshot.root!));
  assert.equal(evaluate(hiddenA, hiddenB).status, "failed");
  assert.equal(evaluate(hiddenA, hiddenB, { selector: { resourceId: "missing" } }).status, "failed");
  const [visible, hidden] = pair(); hide(hidden.snapshot.root!);
  assert.equal(evaluate(visible, hidden).status, "insufficient_evidence");
});

test("partial retains existing source, service, capture, page, display and freshness gates", () => {
  const cases: Array<(a: DebugTaskEvidence, b: DebugTaskEvidence) => void> = [
    (a, b) => { b.observation.snapshotId = a.observation.snapshotId; },
    (a, b) => { b.observation.capturedAt = a.observation.capturedAt; },
    (a, b) => { b.snapshot.helperObservation!.captureId = a.snapshot.helperObservation!.captureId; },
    (_a, b) => { b.snapshot.helperObservation!.serviceInstanceId = randomUUID(); },
    (_a, b) => { b.observation.component = `${pkg}/.Other`; },
    (_a, b) => { b.observation.windowId = "different"; },
    (_a, b) => { b.observation.activityRecordId = "different"; },
    (_a, b) => { b.snapshot.serial = "other-device"; },
    (_a, b) => { b.snapshot.helperObservation!.timing.startedAtMs = 99; },
    (_a, b) => { b.snapshot.captureGeometry!.afterScreenshot!.rotation = 1; },
  ];
  for (const change of cases) {
    const [a, b] = pair(); change(a, b); assert.equal(evaluate(a, b).status, "insufficient_evidence");
  }
});

test("UIAutomator cannot opt into partial but retains its default visible assertion", () => {
  const [a, b] = pair(snapshot => { snapshot.inspectionSource = "uiautomator"; delete snapshot.helperObservation; });
  assert.equal(helperNodePartialVisibility(a.snapshot, a.snapshot.root!).status, "unknown");
  assert.equal(evaluate(a, b).status, "insufficient_evidence");
  assert.equal(evaluate(a, b, { visibility: undefined }).status, "passed");
});

test("partial is visible-only and malformed/common-region overflow inputs fail closed", () => {
  for (const state of ["absent", "enabled", "disabled"] as const) {
    assert.equal(debugTaskCondition.safeParse({ id: "condition", selector, state, visibility: "partial" }).success, false);
    const [a, b] = pair(); assert.equal(evaluate(a, b, { state }).status, "insufficient_evidence");
  }
  const good: HelperPartialVisibilityResult = { status: "exposed", regions: [{ left: 0, top: 0, right: 1, bottom: 1 }] };
  for (const invalid of [
    { status: "unknown" as const, regions: good.regions },
    { status: "occluded" as const, regions: good.regions },
    { status: "exposed" as const, regions: [] },
    { status: "exposed" as const, regions: [{ left: 0.5, top: 0, right: 1, bottom: 1 }] },
    { status: "exposed" as const, regions: Array.from({ length: 257 }, () => good.regions[0]) },
  ]) assert.equal(commonHelperPartialVisibilityRegion(good, invalid), null);
});
