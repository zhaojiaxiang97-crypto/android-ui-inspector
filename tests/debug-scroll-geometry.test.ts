import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { resolveScroll } from "../electron/automation/debug-target-resolution";
import type { UiNode, UiSnapshot } from "../shared/types";

const pkg = "com.example.scroll";
const bounds = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom, raw: "" });
function node(id: string, rect: UiNode["bounds"]): UiNode {
  return { ...makeNode(id), package: pkg, bounds: rect, children: [], attributes: {}, text: null, contentDesc: null,
    resourceId: null, clickable: false, scrollable: false, selected: false, enabled: true, visibleToUser: true, visibilityEvidence: "unknown" };
}
function scrollPage(): UiSnapshot {
  const root = node("0", bounds(0, 104, 1080, 2355)); root.attributes = { "debug-observation-window-id": "main" };
  const list = node("0/0", bounds(0, 1426, 1080, 2355)); list.resourceId = `${pkg}:id/recycler_view`; list.scrollable = true;
  const bar = node("0/1", bounds(0, 1934, 1080, 2355));
  const row = node("0/1/0", bounds(0, 2218, 1080, 2355));
  row.children = [[0, 216], [216, 432], [648, 864], [864, 1080]].map(([left, right], i) => {
    const tab = node(`${row.id}/${i}`, bounds(left, 2218, right, 2355));
    tab.className = "androidx.appcompat.app.ActionBar$Tab"; tab.clickable = true; tab.selected = i === 3; return tab;
  });
  const camera = node("0/1/1", bounds(432, 2220, 643, 2355)); camera.clickable = true;
  bar.children = [row, camera]; root.children = [list, bar];
  const frame = { width: 1080, height: 2400, rotation: 0 as const };
  return { serial: "fixture", root, nodeCount: 9, xmlSize: 0, rawXml: null, error: null, warning: null,
    screenshotDataUrl: null, captureMode: "fast", inspectionSource: "uiautomator",
    captureGeometry: { screenshotSize: frame, beforeScreenshot: frame, afterScreenshot: frame, hierarchyRotation: 0 } };
}
const options = { direction: "down" as const, distance: 0.8, durationMs: 350 };
const resolve = (page: UiSnapshot) => resolveScroll(page.root!.children[0], page, pkg, options);

test("favorites geometry avoids the actual tab row, not its taller wrapper, and preserves layout bounds", () => {
  const page = scrollPage(), original = structuredClone(page), result = resolve(page);
  assert.deepEqual(result.geometry.viewport, { left: 0, top: 1426, right: 1080, bottom: 2218 });
  assert.equal(result.geometry.excludedNavigation.length, 1);
  assert.ok(result.action.fromY < 2218 && result.action.toY > 1426);
  assert.ok(result.confirmationBounds.bottom < 2218);
  assert.equal(result.action.fromY - result.action.toY, 475);
  assert.deepEqual(page, original);
  page.root!.children[1].children[1].bounds = bounds(434, 2218, 645, 2355);
  assert.deepEqual(resolve(page).geometry, result.geometry, "unrelated camera animation does not change viewport evidence");
});

test("navigation is anchored to shared app content when the decor includes a system navigation inset", () => {
  const page = scrollPage(), content = page.root!;
  const repath = (value: UiNode) => { value.id = value.id.replace(/^0/, "0/0"); value.children.forEach(repath); };
  repath(content);
  page.root = node("0", bounds(0, 0, 1080, 2400)); page.root.children = [content];
  const result = resolveScroll(content.children[0], page, pkg, options);
  assert.equal(result.geometry.viewport.bottom, 2218);
  assert.equal(result.geometry.excludedNavigation.length, 1);
});

test("buttons, bottom sheets, 1px nodes and tabs inside scrolling content do not become navigation", () => {
  for (const kind of ["buttons", "sheet", "sliver", "nested", "unknown-selection", "overlapping-tabs"]) {
    const page = scrollPage(), list = page.root!.children[0], bar = page.root!.children[1], tabs = bar.children[0].children;
    if (kind === "buttons") tabs.forEach(tab => { tab.className = "android.widget.Button"; });
    if (kind === "sheet") tabs.forEach(tab => { tab.bounds!.top = 1800; });
    if (kind === "sliver") tabs.forEach(tab => { tab.bounds!.top = 2354; });
    if (kind === "unknown-selection") tabs.forEach(tab => { tab.selected = false; });
    if (kind === "overlapping-tabs") tabs[1].bounds!.left = 100;
    if (kind === "nested") {
      page.root!.children.pop(); bar.id = "0/0/0"; bar.children[0].id = "0/0/0/0";
      tabs.forEach((tab, i) => { tab.id = `0/0/0/0/${i}`; }); bar.children[1].id = "0/0/0/1"; list.children = [bar];
    }
    const result = resolve(page);
    assert.equal(result.geometry.excludedNavigation.length, 0, kind);
    assert.equal(result.geometry.viewport.bottom, 2355, kind);
    assert.ok(result.confirmationBounds.bottom < 2218, "conservative inner gesture still avoids edge controls");
  }
});

test("a foreign window in the original area cannot disappear through clipping or ancestor filtering", () => {
  for (const descendant of [false, true]) for (const differentPackage of [false, true]) {
    const page = scrollPage(), overlay = node(descendant ? "0/0/0" : "0/2", bounds(0, 2250, 1080, 2355));
    overlay.clickable = true;
    if (differentPackage) overlay.package = "com.other.app";
    else overlay.attributes = { "window-id": "dialog" };
    if (descendant) page.root!.children[0].children.push(overlay); else page.root!.children.push(overlay);
    assert.throws(() => resolve(page), /其他 App 或窗口/);
  }
});

test("ordinary layout overflow is retained, but scrollable ancestors clip the usable viewport", () => {
  const page = scrollPage(), list = page.root!.children[0], wrapper = node("0/0", bounds(0, 1500, 1080, 2100));
  list.id = "0/0/0"; wrapper.children = [list]; page.root!.children[0] = wrapper;
  const run = () => resolveScroll(list, page, pkg, options);
  assert.equal(run().geometry.viewport.top, 1426);
  wrapper.scrollable = true;
  assert.deepEqual(run().geometry.viewport, { left: 0, top: 1500, right: 1080, bottom: 2100 });
  wrapper.bounds!.bottom = 1510;
  assert.throws(run, /太小/);
});

test("touch-slop corridor checks still reject nearby interceptors and nested scroll containers", () => {
  for (const nested of [false, true]) {
    const page = scrollPage(), result = resolve(page);
    const overlay = node(nested ? "0/0/0" : "0/2", bounds(result.action.fromX + 10, 1700, result.action.fromX + 20, 2000));
    overlay.clickable = !nested; overlay.scrollable = nested;
    if (nested) page.root!.children[0].children.push(overlay); else page.root!.children.push(overlay);
    assert.throws(() => resolve(page), nested ? /嵌套/ : /占用/);
  }
});

test("navigation evidence is independent of branch order even with multiple overlapping tab rows", () => {
  const page = scrollPage(), duplicate = structuredClone(page.root!.children[1]);
  const repath = (value: UiNode) => { value.id = value.id.replace(/^0\/1/, "0/3"); value.children.forEach(repath); };
  repath(duplicate); duplicate.children[0].children.forEach(tab => { tab.bounds!.top = 2200; });
  page.root!.children.push(duplicate);
  const before = resolve(page).geometry;
  page.root!.children = [page.root!.children[0], duplicate, page.root!.children[1]];
  assert.deepEqual(resolve(page).geometry, before);
});
