import { Menu } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import type { AppMenuAction, AppMenuState } from "../../shared/types";
import { commandEnabled, doubleClickChoices, workbenchCommands, type WorkbenchCommand } from "../../shared/workbench-commands";

export function renderApplicationMenu(state: AppMenuState | undefined, debugActive: boolean, debugStarting: boolean, send: (action: AppMenuAction) => void) {
  if (process.platform !== "darwin") return;
  const command = (type: WorkbenchCommand): MenuItemConstructorOptions => {
    const definition: { label: string; accelerator?: string } = workbenchCommands[type];
    return { id: type, ...definition, enabled: commandEnabled(type, state, debugActive, debugStarting), click: () => send({ type }) };
  };
  const ready = state?.canSelectDevice ?? Boolean(state && !state.loading && !state.capturing);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Android UI Inspector", submenu: [{ role: "about" }, { type: "separator" }, command("preferences"), { type: "separator" }, { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] },
    { label: "文件", submenu: [
      command("open-snapshot"), { type: "separator" }, command("capture"), command("cancel"), { type: "separator" }, command("save"), command("history"),
      { label: "导出", submenu: [command("export-snapshot"), { type: "separator" }, command("export-json"), command("export-xml"), command("export-png")] },
      command("test-report"),
      { label: "MCP", submenu: [command("debug-start"), command("mcp-share"), command("mcp-stop"), command("mcp-config")] },
      command("home"), { type: "separator" }, { role: "close" },
    ] },
    { label: "设备", submenu: [
      command("refresh"), { type: "separator" },
      ...(state?.devices.length ? state.devices.map((device): MenuItemConstructorOptions => ({
        label: `${device.model || device.serial} · ${device.serial} · ${device.state === "device" ? "已授权" : device.state === "unauthorized" ? "待授权" : "离线"}`,
        type: "radio", checked: device.serial === state.selectedSerial,
        enabled: ready && device.state === "device",
        click: () => send({ type: "device", serial: device.serial }),
      })) : [{ label: "未发现设备", enabled: false }]),
    ] },
    { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "视图", submenu: [
      command("search"), command("expand-all"), command("collapse-all"), { type: "separator" },
      command("focus-branch"), command("focus-layer"), command("exit-focus"), command("expand-selected"), command("collapse-selected"),
      command("hide-selected"), command("restore-layers"),
      { label: "双击行为", submenu: doubleClickChoices.map(({ value: action, label }): MenuItemConstructorOptions => ({
        id: `double-click-${action}`, label, type: "radio", checked: (state?.doubleClickAction ?? "toggle") === action,
        click: () => send({ type: "double-click", action }),
      })) },
      { type: "separator" }, { role: "togglefullscreen" },
    ] },
    { role: "windowMenu", label: "窗口" },
  ]));
}

export function isAppMenuState(input: unknown): input is AppMenuState {
  if (!input || typeof input !== "object") return false;
  const value = input as AppMenuState;
  const shortString = (text: unknown) => typeof text === "string" && text.length <= 256;
  return shortString(value.selectedSerial)
    && [value.loading, value.capturing, value.inspecting, value.hasSnapshot, value.filtered].every(flag => typeof flag === "boolean")
    && (value.mcpSharing === undefined || typeof value.mcpSharing === "boolean")
    && [value.canCapture, value.canSelectDevice, value.hasRawXml, value.hasScreenshot, value.historyLoading, value.openingSnapshot, value.canFocus, value.canHideLayer, value.hasHiddenLayers, value.hasLayerFocus, value.selectedExpandable, value.selectedExpanded]
      .every(flag => flag === undefined || typeof flag === "boolean")
    && (value.doubleClickAction === undefined || ["toggle", "focus-branch", "expand"].includes(value.doubleClickAction))
    && Array.isArray(value.devices) && value.devices.length <= 128
    && value.devices.every(device => device && shortString(device.serial) && shortString(device.state) && (device.model === null || shortString(device.model)));
}
