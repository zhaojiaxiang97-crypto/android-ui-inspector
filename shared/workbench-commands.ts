import type { AppMenuAction, AppMenuState, LayerCopyAction, LayerImageAction, LayerLocalAction, LayerMenuAction } from "./types";

export const workbenchCommands = {
  capture: { label: "采集当前画面", accelerator: "CmdOrCtrl+R" },
  cancel: { label: "取消采集", accelerator: "CmdOrCtrl+." },
  refresh: { label: "刷新设备", accelerator: "CmdOrCtrl+Shift+R" },
  home: { label: "返回设备列表", accelerator: "CmdOrCtrl+Shift+H" },
  search: { label: "搜索控件", accelerator: "CmdOrCtrl+K" },
  save: { label: "保存快照", accelerator: "CmdOrCtrl+S" },
  history: { label: "快照与历史" },
  "open-snapshot": { label: "打开快照…", accelerator: "CmdOrCtrl+O" },
  "export-snapshot": { label: "导出完整快照…" },
  "export-json": { label: "导出 JSON", accelerator: "CmdOrCtrl+Shift+S" },
  "export-xml": { label: "导出 XML" },
  "export-png": { label: "导出 PNG" },
  preferences: { label: "偏好设置…", accelerator: "CmdOrCtrl+," },
  "test-report": { label: "测试报告" },
  "expand-all": { label: "展开全部层级" },
  "collapse-all": { label: "收起全部层级" },
  "focus-branch": { label: "聚焦分支" },
  "focus-layer": { label: "仅看此层" },
  "exit-focus": { label: "退出聚焦" },
  "expand-selected": { label: "展开此层" },
  "collapse-selected": { label: "收起此层" },
  "hide-selected": { label: "隐藏此图层" },
  "restore-layers": { label: "恢复所有隐藏图层" },
  "debug-start": { label: "开启自动调试…" },
  "mcp-share": { label: "共享当前快照（只读）" },
  "mcp-stop": { label: "停止 MCP / 自动调试" },
  "mcp-config": { label: "复制 MCP 配置" },
} satisfies Record<Exclude<AppMenuAction["type"], "device" | "double-click">, { label: string; accelerator?: string }>;

export type WorkbenchCommand = keyof typeof workbenchCommands;
export const layerCommands: Record<Exclude<LayerMenuAction, LayerCopyAction | LayerImageAction | LayerLocalAction | null>, WorkbenchCommand> = {
  hide: "hide-selected", restore: "restore-layers", focus: "focus-layer", "focus-branch": "focus-branch",
  "exit-focus": "exit-focus", expand: "expand-selected", collapse: "collapse-selected",
};
export const doubleClickChoices = [
  { value: "toggle", label: "展开 / 收起" },
  { value: "focus-branch", label: "聚焦分支" },
  { value: "expand", label: "仅展开（兼容）" },
] as const;

export function commandEnabled(type: WorkbenchCommand, state: AppMenuState | undefined,
  debugActive = false, debugStarting = false): boolean {
  const ready = Boolean(state && !state.loading);
  const tree = Boolean(state?.hasSnapshot && !state.capturing);
  const capture = ready && !state?.capturing && (state?.canCapture
    ?? Boolean(state?.devices.some(device => device.serial === state.selectedSerial && device.state === "device")));
  switch (type) {
    case "capture": return capture;
    case "cancel": return Boolean(state?.capturing);
    case "refresh": return ready;
    case "home": return Boolean(state?.inspecting);
    case "preferences": case "history": case "test-report": case "mcp-config": return true;
    case "save": return tree && !state?.historyLoading;
    case "open-snapshot": return !state?.capturing && !state?.openingSnapshot && !debugActive && !debugStarting;
    case "export-snapshot": return tree && !state?.openingSnapshot;
    case "search": case "export-json": return tree;
    case "export-xml": return tree && Boolean(state?.hasRawXml);
    case "export-png": return tree && Boolean(state?.hasScreenshot);
    case "expand-all": case "collapse-all": return tree && !state?.filtered;
    case "focus-branch": case "focus-layer": return tree && Boolean(state?.canFocus);
    case "exit-focus": return tree && Boolean(state?.hasLayerFocus);
    case "expand-selected": return tree && !state?.filtered && Boolean(state?.selectedExpandable && !state.selectedExpanded);
    case "collapse-selected": return tree && !state?.filtered && Boolean(state?.selectedExpandable && state.selectedExpanded);
    case "hide-selected": return tree && Boolean(state?.canHideLayer);
    case "restore-layers": return tree && Boolean(state?.hasHiddenLayers);
    case "debug-start": return capture && !debugActive && !debugStarting;
    case "mcp-share": return tree && !debugActive && !debugStarting;
    case "mcp-stop": return Boolean(state?.mcpSharing || debugActive || debugStarting);
  }
}

export function commandShortcut(type: WorkbenchCommand, mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform)) {
  const command: { label: string; accelerator?: string } = workbenchCommands[type];
  return (command.accelerator ?? "").replace("CmdOrCtrl", mac ? "⌘" : "Ctrl").replace("Shift", mac ? "⇧" : "Shift").split("+").join(mac ? "" : "+");
}

export function commandForShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform)): WorkbenchCommand | null {
  if (event.altKey || (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return null;
  const key = event.key.toLowerCase();
  if (event.shiftKey) return key === "r" ? "refresh" : key === "h" ? "home" : key === "s" ? "export-json" : null;
  return key === "r" ? "capture" : key === "." ? "cancel" : key === "k" ? "search" : key === "s" ? "save" : key === "o" ? "open-snapshot" : key === "," ? "preferences" : null;
}
