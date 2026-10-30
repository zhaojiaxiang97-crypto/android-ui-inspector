import type { MenuItemConstructorOptions } from "electron";
import { layerCopyActions, layerCopyLabels, layerImageActions, layerImageActionDetails, layerLocalLabels, layerMenuActionEnabled, layerRefreshActions, layerRefreshActionScope, layerRefreshLabels } from "../../shared/layer-context-menu";
import type { LayerMenuAction, LayerMenuOptions } from "../../shared/types";
import { layerCommands, workbenchCommands } from "../../shared/workbench-commands";

export function renderLayerContextMenu(canHide: boolean, canRestore: boolean, canExitFocus: boolean, options: LayerMenuOptions | undefined,
  select: (action: LayerMenuAction) => void): MenuItemConstructorOptions[] {
  const local = (action: keyof typeof layerLocalLabels): MenuItemConstructorOptions => ({ id: action, label: layerLocalLabels[action], enabled: layerMenuActionEnabled(action, options), click: () => select(action) });
  const command = (action: keyof typeof layerCommands, enabled: boolean): MenuItemConstructorOptions => ({ id: action, label: workbenchCommands[layerCommands[action]].label, enabled, click: () => select(action) });
  const menu: MenuItemConstructorOptions[] = [
    ...layerCopyActions.filter(action => options?.copyActions?.includes(action)).map(action => ({ id: action, label: `复制${layerCopyLabels[action]}`, click: () => select(action) })),
  ];
  if (options?.mode !== "flat") menu.push(
    ...(menu.length ? [{ type: "separator" as const }] : []),
    command("focus-branch", options?.canFocus ?? canHide), command("focus", options?.canFocus ?? canHide), command("exit-focus", canExitFocus),
    { type: "separator" }, command("expand", Boolean(options?.expandable && !options.expanded)), command("collapse", Boolean(options?.expandable && options.expanded)),
    ...((options?.hasChildren ?? options?.expandable) ? [local("expand-branch"), local("collapse-children")] : []),
    { type: "separator" }, command("hide", canHide),
    ...(options?.canRestoreSelected ? [local("restore-selected")] : []),
    ...(options?.hiddenAncestorLabel ? [{ ...local("locate-hidden-ancestor"), label: `${layerLocalLabels["locate-hidden-ancestor"]}：${options.hiddenAncestorLabel}` }] : []),
    { type: "separator" }, command("restore", canRestore),
  );
  if (options?.refreshScopes?.length) {
    if (menu.length) menu.push({ type: "separator" });
    for (const action of layerRefreshActions) {
      const scope = options.refreshScopes.find(item => item.scope === layerRefreshActionScope(action));
      if (!scope) continue;
      menu.push({ id: action, label: layerRefreshLabels[action], enabled: layerMenuActionEnabled(action, options), toolTip: scope.detail, click: () => select(action) });
      if (!scope.available) menu.push({ id: `${action}-reason`, label: `${layerRefreshLabels[action]}不可用：${scope.detail.length > 90 ? `${scope.detail.slice(0, 89)}…` : scope.detail}`, enabled: false, toolTip: scope.detail });
    }
  }
  if (options?.imageScopes?.length) {
    if (menu.length) menu.push({ type: "separator" });
    menu.push({ id: "node-images", label: "控件图片", submenu: options.imageScopes.map(scope => ({
      label: scope.scope === "own" ? "自身图" : "分支图", submenu: [
        { label: scope.label, enabled: false },
        ...layerImageActions.filter(action => layerImageActionDetails(action).scope === scope.scope).map(action => ({ id: action,
          label: ({ preview: "预览图片", copy: "复制图片", save: "导出 PNG…" } as const)[layerImageActionDetails(action).action], enabled: scope.available, click: () => select(action) })),
        ...(!scope.available ? [{ label: scope.detail.length > 90 ? `${scope.detail.slice(0, 89)}…` : scope.detail || "当前图片不可用", toolTip: scope.detail, enabled: false }] : []),
      ],
    })) });
  }
  return menu;
}
