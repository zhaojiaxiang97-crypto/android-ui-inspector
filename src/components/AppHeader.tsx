import { useState } from "react";
import type { DeviceInfo } from "../../shared/types";

type StatusTone = "danger" | "success" | "neutral";

type Props = {
  inspectionActive: boolean;
  selectedSerial: string | null;
  devices: DeviceInfo[];
  toolbarSerial: string;
  toolbarDevice: DeviceInfo | null;
  statusTone: StatusTone;
  runtimeError: string | null;
  probeError: string | null;
  hasAdb: boolean;
  checkedAt: Date | null;
  loading: boolean;
  inspectionLoading: boolean;
  captureSerial: string | null;
  treeQuery: string;
  onBack: () => void;
  onSelectDevice: (serial: string) => void;
  onRefresh: () => void;
  onCapture: () => void;
  onSearchChange: (value: string) => void;
  setSceneToolbarHost: (node: HTMLDivElement | null) => void;
};

function formatCheckedAt(date: Date | null) {
  if (!date) return "尚未检查";
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function stateLabel(state: string) {
  if (state === "device") return "已授权";
  if (state === "unauthorized") return "待授权";
  if (state === "offline") return "离线";
  return state;
}

function keyboardShortcutLabel() {
  if (typeof navigator === "undefined") return "Ctrl K";
  return /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ K" : "Ctrl K";
}

export function AppHeader({
  inspectionActive,
  selectedSerial,
  devices,
  toolbarSerial,
  toolbarDevice,
  statusTone,
  runtimeError,
  probeError,
  hasAdb,
  checkedAt,
  loading,
  inspectionLoading,
  captureSerial,
  treeQuery,
  onBack,
  onSelectDevice,
  onRefresh,
  onCapture,
  onSearchChange,
  setSceneToolbarHost,
}: Props) {
  const [helpOpen, setHelpOpen] = useState(false);
  const statusMessage = runtimeError || probeError;
  const shortcutLabel = keyboardShortcutLabel();

  return (
    <header className={`topbar ${inspectionActive ? "is-inspection" : "is-home"}`}>
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
        </div>
        <div>
          <p className="eyebrow">ANDROID TOOLING</p>
          <h1>Android UI Inspector</h1>
        </div>
        <span className="alpha-badge">ALPHA</span>
      </div>

      <div className="topbar-meta inspector-toolbar">
        {selectedSerial && (
          <button className="toolbar-back-button" type="button" onClick={onBack} aria-label="返回设备列表">
            ‹ 返回
          </button>
        )}
        <div className="toolbar-device-control">
          <span className={`connection-dot ${statusTone}`} aria-hidden="true" />
          <label className="toolbar-label" htmlFor="device-select">目标设备</label>
          <select
            id="device-select"
            className="device-select"
            aria-label="选择 Android 设备"
            value={toolbarSerial}
            onChange={(event) => onSelectDevice(event.currentTarget.value)}
          >
            <option value="">{devices.length > 0 ? "选择设备" : "未发现设备"}</option>
            {devices.map((device) => (
              <option
                key={device.serial}
                value={device.serial}
                data-device-state={device.state}
                className="device-option"
              >
                {device.model ?? "Android device"} · {stateLabel(device.state)}
              </option>
            ))}
            {selectedSerial && !toolbarDevice && (
              <option value={selectedSerial} data-device-state="history">{selectedSerial} · 历史快照</option>
            )}
          </select>
          {toolbarDevice && <span className={`device-state toolbar-device-state ${toolbarDevice.state}`}>{stateLabel(toolbarDevice.state)}</span>}
        </div>
        <span className={`toolbar-status ${statusTone}`} title={statusMessage || undefined}>
          {statusMessage ? "连接异常" : captureSerial ? "设备已连接" : "等待设备"}
        </span>
        <span className={`adb-badge ${hasAdb ? "ready" : "missing"}`}>ADB {hasAdb ? "READY" : "MISSING"}</span>
        <span className="toolbar-checked">{formatCheckedAt(checkedAt)}</span>
        <button className="refresh-button" type="button" onClick={onRefresh} disabled={loading}>
          <span className={loading ? "refresh-icon spinning" : "refresh-icon"}>↻</span>
          {loading ? "检查中" : "刷新设备"}
        </button>
        <button className="capture-button" type="button" onClick={onCapture} disabled={!captureSerial || inspectionLoading || loading}>
          <span className={inspectionLoading ? "capture-icon spinning" : "capture-icon"} aria-hidden="true">●</span>
          {inspectionLoading ? "采集中…" : "采集截图"}
        </button>
        <label className="topbar-search" htmlFor="global-node-search">
          <span aria-hidden="true">⌕</span>
          <input
            id="global-node-search"
            type="search"
            value={treeQuery}
            onChange={(event) => onSearchChange(event.currentTarget.value)}
            placeholder="搜索节点…"
            aria-label="搜索 UI 节点"
          />
          <kbd>{shortcutLabel}</kbd>
        </label>
      </div>

      <div className="scene-toolbar-host" ref={setSceneToolbarHost} />
      <div className="toolbar-help-wrap">
        <button
          className="toolbar-help-button"
          type="button"
          aria-label="使用帮助"
          aria-expanded={helpOpen}
          aria-controls="toolbar-help-popover"
          title="使用帮助"
          onClick={() => setHelpOpen((value) => !value)}
        >
          ?
        </button>
        {helpOpen && (
          <div id="toolbar-help-popover" className="toolbar-help-popover" role="dialog" aria-label="使用帮助">
            <strong>快速开始</strong>
            <p>连接并授权 Android 设备后，使用“采集截图”读取当前 UI hierarchy。</p>
            <p><kbd>{shortcutLabel}</kbd> 可快速聚焦节点搜索。</p>
          </div>
        )}
      </div>
    </header>
  );
}
