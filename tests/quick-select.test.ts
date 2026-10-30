import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { UiNode } from "../shared/types";
import { makeNode } from "../benchmarks/fixtures";
import { findQuickSelectCandidates, pointOnPaintedPlane, QUICK_SELECT_PAGE_SIZE } from "../src/features/layers/quick-select";
import type { ProjectedPlane, ScenePlane } from "../src/features/layers/types";

function node(id: string, left = 0, top = 0, right = 200, bottom = 200): UiNode {
  return { ...makeNode(id), text: id, bounds: { left, top, right, bottom, raw: `[${left},${top}][${right},${bottom}]` } };
}
function query(root: UiNode, branch = root, x = 50, y = 50, other: Partial<Parameters<typeof findQuickSelectCandidates>[0]> = {}) {
  return findQuickSelectCandidates({ root, branch, context: {}, point: { x, y }, hidden: new Set(), ...other });
}

describe("folded branch quick selection", () => {
  test("uses perspective-correct painted coordinates instead of the projected bounding box", () => {
    const root = node("root");
    const plane: ScenePlane = { id: root.id, node: root, rect: { left: 0, top: 0, width: 100, height: 200 },
      source: { left: 0, top: 0, width: 200, height: 100 }, textureSize: { width: 200, height: 100 }, textureSrc: "group",
      z: 0, kind: "composite", opacity: 1, hitTestable: true, quickSelect: { collapsed: true, screen: { left: 20, top: 40, width: 200, height: 100 } } };
    const projected: ProjectedPlane = { node: root, depth: 250, corners: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 700 }, { x: 0, y: 200 }],
      painted: { plane, cornerDepths: [0, 500, 500, 0], pivot: { x: 0, y: 0, z: 0 }, visible: true, kind: "composite",
        camera: { distance: 700, azimuth: 0, elevation: 0, roll: 0, panX: 0, panY: 0, layerGap: 64 } } };
    // Independent rational projection of source u=.25,v=.75, with vertex W=700/200.
    const mapped = pointOnPaintedPlane(projected, { x: 80_000 * .25 / 575, y: 140_000 * .75 / 575 })!;
    assert.ok(Math.abs(mapped.x - 70) < 1e-8); assert.ok(Math.abs(mapped.y - 115) < 1e-8);
    assert.equal(pointOnPaintedPlane(projected, { x: 410, y: 10 }), null);
    projected.painted!.cornerDepths[1] = 700;
    assert.equal(pointOnPaintedPlane(projected, { x: 20, y: 50 }), null);
  });

  test("matches only real descendants, deepest first, and leaves hidden/outside controls out", () => {
    const root = node("root"), branch = node("branch"), holder = node("holder"), text = node("text"), hidden = node("hidden"), outside = node("outside");
    holder.children = [text, hidden]; branch.children = [holder]; root.children = [branch, outside];
    const result = query(root, branch, 50, 50, { hidden: new Set([hidden.id]) });
    assert.deepEqual(result.candidates.map(entry => entry.node), [text, holder]);
    assert.equal(result.candidates[0].path, "branch › holder › text");
    assert.ok(!result.candidates.map(entry => entry.node.id).includes(outside.id));
    assert.equal(branch.children[0], holder); assert.equal(hidden.visibleToUser, true);
  });

  test("respects ancestor clips, padding and rounded outlines", () => {
    const root = node("root", 0, 0, 100, 100), branch = node("branch", 0, 0, 150, 150), child = node("child", 0, 0, 150, 150);
    root.attributes = { "clip-children": "true", "clip-to-padding": "true", "padding-left": "10", "padding-top": "20", "padding-right": "5", "padding-bottom": "10" };
    root.children = [branch]; branch.children = [child];
    assert.equal(query(root, branch, 5, 50).status, "unsupported");
    assert.equal(query(root, branch, 110, 50).status, "unsupported");
    assert.deepEqual(query(root, branch, 50, 50).candidates[0].bounds, { left: 10, top: 20, width: 85, height: 70 });
    root.attributes = { "clip-to-outline": "true", "sdk-outlineLeft": "0", "sdk-outlineTop": "0", "sdk-outlineRight": "100", "sdk-outlineBottom": "100", "sdk-outlineRadius": "25" };
    assert.equal(query(root, branch, 1, 1).status, "unsupported");
    assert.equal(query(root, branch, 30, 30).total, 1);
    root.attributes["sdk-outlineRadius"] = "unsupported";
    assert.ok(query(root, branch, 50, 50).message.includes("无法可靠映射"));
  });

  test("rejects stale objects and outside/single-layer focus instead of guessing by ID", () => {
    const root = node("root"), branch = node("branch"), sibling = node("sibling"); branch.children = [node("child")]; root.children = [branch, sibling];
    assert.equal(query(root, { ...branch }).status, "stale");
    assert.equal(query(root, branch, 50, 50, { focusedNode: sibling, focusKind: "branch" }).status, "unsupported");
    assert.equal(query(root, branch, 50, 50, { focusedNode: branch, focusKind: "layer" }).status, "unsupported");
    assert.equal(query(root, branch, 50, 50, { focusedNode: branch, focusKind: "branch" }).total, 1);
    assert.equal(query(root, branch, 50, 50, { hidden: new Set([root.id]) }).status, "unsupported");
  });

  test("pages all candidates in groups of 30 and reports unmappable branches", () => {
    const root = node("root"); root.children = Array.from({ length: 87 }, (_, i) => node(`candidate-${i}`));
    root.children[85].attributes = { rotation: "45" }; root.children[86].attributes = { "image-capture-placement": "unsupported-context-legacy-fallback" };
    const first = query(root), second = query(root, root, 50, 50, { page: 1 }), last = query(root, root, 50, 50, { page: 900 });
    assert.equal(first.total, 85); assert.equal(first.unsupported, 2); assert.equal(first.candidates.length, QUICK_SELECT_PAGE_SIZE);
    assert.equal(second.candidates[0].node.id, "candidate-30"); assert.equal(last.page, 2); assert.equal(last.candidates.length, 25);
    assert.equal(query(root, root, 50, 50, { page: -1 }).page, 0);
  });

  test("does not clip overflowing descendants when their containers allow them", () => {
    const root = node("root"), branch = node("branch"), small = node("small", 0, 0, 20, 20), child = node("child", 40, 40, 70, 70);
    root.children = [branch]; branch.children = [small]; small.children = [child];
    assert.deepEqual(query(root, branch).candidates.map(entry => entry.node.id), [child.id]);
    small.attributes = { "clip-children": "true" };
    assert.equal(query(root, branch).total, 0);
  });

  test("explicitly skips scaled placements rather than matching their old bounds", () => {
    const root = node("root"), scaled = node("scaled", 10, 10, 30, 30); root.children = [scaled];
    scaled.attributes = { "scale-x": "2", "scale-y": "2", "image-capture-placement": "verified-rectangle" };
    scaled.layerCapturePlacement = { screen: { left: 10, top: 10, width: 40, height: 40 }, source: { left: 0, top: 0, width: 20, height: 20 }, opacity: 1, hidden: false };
    const result = query(root, root, 45, 20);
    assert.equal(result.total, 0); assert.equal(result.unsupported, 1);
    delete scaled.attributes["scale-x"]; delete scaled.attributes["scale-y"];
    assert.equal(query(root, root, 45, 20).unsupported, 1);
    root.attributes = { "scale-x": "2" };
    assert.equal(query(root, root, 45, 20).status, "unsupported");
  });
});
