import assert from "node:assert/strict";
import { test } from "node:test";
import type { MenuItemConstructorOptions } from "electron";
import { renderLayerContextMenu } from "../electron/desktop/layer-context-menu";
import type { LayerMenuAction, LayerMenuOptions } from "../shared/types";

function items(template: MenuItemConstructorOptions[]) {
  const map = new Map<string, MenuItemConstructorOptions>();
  for (const item of template) {
    if (item.id) map.set(item.id, item);
    if (Array.isArray(item.submenu)) for (const [id, child] of items(item.submenu)) map.set(id, child);
  }
  return map;
}
const base: LayerMenuOptions = { canFocus: false, expandable: false, expanded: false };

test("leaf and filtered branch menus distinguish existence from availability", () => {
  const leaf = items(renderLayerContextMenu(false, false, false, { ...base, hasChildren: false }, () => {}));
  assert(!leaf.has("expand-branch")); assert(!leaf.has("collapse-children")); assert(!leaf.has("restore-selected")); assert(!leaf.has("node-images"));
  const filtered = items(renderLayerContextMenu(false, false, false, { ...base, hasChildren: true }, () => {}));
  assert.equal(filtered.get("expand-branch")?.enabled, false); assert.equal(filtered.get("collapse-children")?.enabled, false);
  const branch = items(renderLayerContextMenu(true, false, false, { ...base, hasChildren: true, expandable: true }, () => {}));
  assert.equal(branch.get("expand-branch")?.enabled, true); assert.equal(branch.get("collapse-children")?.enabled, true);
});

test("individual restore and hidden parent use distinct menu callbacks", () => {
  const actions: LayerMenuAction[] = [];
  const menu = items(renderLayerContextMenu(false, true, false, { ...base, canRestoreSelected: true, hiddenAncestorLabel: "父容器" }, action => actions.push(action)));
  for (const id of ["restore-selected", "locate-hidden-ancestor", "restore"]) {
    assert.equal(menu.get(id)?.enabled, true); (menu.get(id)!.click as () => void)();
  }
  assert.deepEqual(actions, ["restore-selected", "locate-hidden-ancestor", "restore"]);
  assert(menu.get("locate-hidden-ancestor")!.label?.includes("父容器"));
});

test("image submenu keeps own and branch sources with disabled missing-image actions", () => {
  const actions: LayerMenuAction[] = [];
  const menu = items(renderLayerContextMenu(false, false, false, { ...base, imageScopes: [
    { scope: "own", available: true, label: "自身独立图 · SDK", detail: "保留透明度" },
    { scope: "branch", available: false, label: "没有可导出的图片", detail: "此分支没有保存的位图，不会从整屏裁图。" },
  ] }, action => actions.push(action)));
  for (const kind of ["preview", "copy", "save"]) {
    assert.equal(menu.get(`${kind}-image-own`)?.enabled, true);
    assert.equal(menu.get(`${kind}-image-branch`)?.enabled, false);
    (menu.get(`${kind}-image-own`)!.click as () => void)();
  }
  assert.deepEqual(actions, ["preview-image-own", "copy-image-own", "save-image-own"]);
  const scopes = menu.get("node-images")!.submenu as MenuItemConstructorOptions[];
  assert.equal((scopes[0].submenu as MenuItemConstructorOptions[])[0].label, "自身独立图 · SDK");
  assert((scopes[1].submenu as MenuItemConstructorOptions[]).at(-1)!.label?.includes("不会从整屏裁图"));
});

test("flat menus contain copy, image and refresh actions while omitting 3D visibility and focus commands", () => {
  const actions: LayerMenuAction[] = [];
  const template = renderLayerContextMenu(true, true, true, { ...base, mode: "flat", canRestoreSelected: true, hiddenAncestorLabel: "父容器", hasChildren: true,
    copyActions: ["copy-text"], refreshScopes: [{ scope: "node", available: true, detail: "实时 SDK" }],
    imageScopes: [{ scope: "own", available: true, label: "自身独立图", detail: "原尺寸" }],
  }, action => actions.push(action));
  const menu = items(template);
  assert.deepEqual([...menu.keys()], ["copy-text", "refresh-node", "node-images", "preview-image-own", "copy-image-own", "save-image-own"]);
  assert.notEqual(template[0].type, "separator"); assert.notEqual(template.at(-1)?.type, "separator");
  for (const id of ["copy-text", "refresh-node", "preview-image-own"]) (menu.get(id)!.click as () => void)();
  assert.deepEqual(actions, ["copy-text", "refresh-node", "preview-image-own"]);
});

test("refresh menu retains scope order, capability and full unavailable reasons without making absent scopes actionable", () => {
  const detail = "当前快照不支持刷新。".repeat(20), actions: LayerMenuAction[] = [];
  const menu = items(renderLayerContextMenu(false, false, false, { ...base, refreshScopes: [
    { scope: "branch", available: false, detail }, { scope: "node", available: true, detail: "仅刷新此层" },
  ] }, action => actions.push(action)));
  assert.equal(menu.get("refresh-node")?.label, "刷新此层"); assert.equal(menu.get("refresh-node")?.enabled, true);
  assert.equal(menu.get("refresh-branch")?.label, "刷新此分支"); assert.equal(menu.get("refresh-branch")?.enabled, false);
  assert.equal(menu.get("refresh-branch")?.toolTip, detail);
  assert.equal(menu.get("refresh-branch-reason")?.toolTip, detail); assert.equal(menu.get("refresh-branch-reason")?.enabled, false);
  assert.match(menu.get("refresh-branch-reason")!.label!, /^刷新此分支不可用：.*…$/);
  (menu.get("refresh-node")!.click as () => void)(); assert.deepEqual(actions, ["refresh-node"]);
  const leaf = items(renderLayerContextMenu(false, false, false, { ...base, mode: "flat", refreshScopes: [{ scope: "node", available: false, detail: "没有 SDK 引用" }] }, () => {}));
  assert(!leaf.has("refresh-branch")); assert.equal(leaf.get("refresh-node")?.enabled, false);
  const copyOnly = renderLayerContextMenu(false, false, false, { ...base, mode: "flat", copyActions: ["copy-class-name"] }, () => {});
  assert.equal(copyOnly.length, 1); assert.equal(copyOnly[0].id, "copy-class-name");
  assert.deepEqual(renderLayerContextMenu(false, false, false, { ...base, mode: "flat" }, () => {}), []);
});
