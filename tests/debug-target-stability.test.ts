import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { resolveParentTap, resolveScroll, resolveTap } from "../electron/automation/debug-target-resolution";
import type { UiNode, UiSnapshot } from "../shared/types";

const pkg = "com.example.stability";
function fixture() {
  const root = makeNode("0"), button = makeNode("0/0");
  for (const node of [root, button]) {
    node.package = pkg; node.children = []; node.enabled = node.visibleToUser = true;
    node.clickable = node.scrollable = false; node.contentDesc = null; node.text = null;
  }
  root.bounds = { left: 0, top: 0, right: 1080, bottom: 2400, raw: "" };
  button.resourceId = `${pkg}:id/me`; button.text = "我"; button.clickable = true;
  button.bounds = { left: 100, top: 200, right: 300, bottom: 300, raw: "" }; root.children = [button];
  const frame = { width: 1080, height: 2400, rotation: 0 as const };
  const page: UiSnapshot = { serial: "fixture", root, nodeCount: 2, xmlSize: 0, rawXml: null,
    error: null, warning: null, screenshotDataUrl: null,
    captureGeometry: { screenshotSize: frame, hierarchyRotation: 0, beforeScreenshot: frame, afterScreenshot: frame } };
  return page;
}
function move(node: UiNode, dx: number, dy: number) {
  node.bounds = { ...node.bounds!, left: node.bounds!.left + dx, right: node.bounds!.right + dx,
    top: node.bounds!.top + dy, bottom: node.bounds!.bottom + dy };
}

test("unique controls can translate slightly and use fresh coordinates even when node paths change", () => {
  const before = fixture(), after = structuredClone(before), previous = before.root!.children[0], fresh = after.root!.children[0];
  move(fresh, 6, 2); fresh.id = "0/1";
  const hit = resolveTap(previous, after, pkg, before);
  assert.equal(hit.node.id, "0/1"); assert.equal(hit.x, 206); assert.equal(hit.y, 252);
  assert.throws(() => resolveTap(previous, after, pkg), /移动/);
});

test("resizing, larger translations, identity changes and movement significant for a tiny target still reject", () => {
  for (const change of ["resize", "move", "text", "tiny"]) {
    const before = fixture();
    if (change === "tiny") before.root!.children[0].bounds = { left: 100, top: 200, right: 108, bottom: 208, raw: "" };
    const after = structuredClone(before), fresh = after.root!.children[0];
    if (change === "resize") fresh.bounds!.left += 2;
    if (change === "move") move(fresh, 9, 0);
    if (change === "text") fresh.text = "其他";
    if (change === "tiny") move(fresh, 1, 0);
    assert.throws(() => resolveTap(before.root!.children[0], after, pkg, before), /移动/);
  }
});

test("translation cannot choose among duplicated identities in either observation", () => {
  for (const duplicateIn of ["before", "after"]) {
    const before = fixture(), after = structuredClone(before);
    const page = duplicateIn === "before" ? before : after;
    const duplicate = structuredClone(page.root!.children[0]); duplicate.id = "0/1"; move(duplicate, 300, 0);
    page.root!.children.push(duplicate);
    move(after.root!.children[0], 6, 2);
    assert.throws(() => resolveTap(before.root!.children[0], after, pkg, before), /移动/);
  }
  const before = fixture(), after = structuredClone(before);
  const duplicate = structuredClone(after.root!.children[0]); duplicate.id = "0/1"; move(duplicate, 300, 0); after.root!.children.push(duplicate);
  assert.equal(resolveTap(before.root!.children[0], after, pkg, before).node.id, "0/0", "existing exact-bound disambiguation is retained");
});

test("translated controls still reject disabled state and overlapping interactive siblings", () => {
  for (const change of ["disabled", "overlap"]) {
    const before = fixture(), after = structuredClone(before), fresh = after.root!.children[0]; move(fresh, 6, 2);
    if (change === "disabled") fresh.enabled = false;
    else {
      const overlay = structuredClone(fresh); overlay.id = "0/1"; overlay.resourceId = `${pkg}:id/overlay`; after.root!.children.push(overlay);
    }
    assert.throws(() => resolveTap(before.root!.children[0], after, pkg, before), /启用|重叠/);
  }
});

test("parent tap tolerates a small translation while retaining anchor relationship and dimensions", () => {
  const before = fixture(), parent = before.root!.children[0];
  parent.text = parent.resourceId = null;
  const label = structuredClone(parent); label.id = "0/0/0"; label.className = "android.widget.TextView";
  label.text = "我"; label.clickable = false; label.bounds = { left: 130, top: 220, right: 230, bottom: 270, raw: "" };
  parent.children = [label];
  const after = structuredClone(before), freshParent = after.root!.children[0], freshLabel = freshParent.children[0];
  move(freshParent, 6, 2); move(freshLabel, 6, 2);
  const hit = resolveParentTap(label, before, after, pkg);
  assert.equal(hit.node.id, parent.id); assert.equal(hit.anchor.id, label.id); assert.equal(hit.x, 206);
  freshParent.bounds!.right += 2;
  assert.throws(() => resolveParentTap(label, before, after, pkg), /关系或位置/);
});

test("scroll relocation stays strict", () => {
  const before = fixture(), previous = before.root!.children[0]; previous.clickable = false; previous.scrollable = true;
  previous.bounds = { left: 100, top: 100, right: 900, bottom: 2000, raw: "" };
  const after = structuredClone(before); move(after.root!.children[0], 2, 2);
  assert.throws(() => resolveScroll(previous, after, pkg, { direction: "down", distance: 0.6, durationMs: 350 }), /移动/);
});
