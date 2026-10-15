import type { ReactNode } from "react";
import { AppIcon } from "./AppIcon";
import type { DeviceInfo } from "../../shared/types";
import { commandShortcut, workbenchCommands } from "../../shared/workbench-commands";

type StatusTone = "danger" | "success" | "neutral";

type Props = {
  homeMenu?: ReactNode;
  inspectionActive: boolean;
  selectedSerial: string | null;
  devices: DeviceInfo[];
  toolbarSerial: string;
  toolbarDevice: DeviceInfo | null;
  statusTone: StatusTone;
  runtimeError: string | null;
  probeError: string | null;
  loading: boolean;
  inspectionLoading: boolean;
  captureSerial: string | null;
  canSelectDevice: boolean;
  onBack: () => void;
  onSelectDevice: (serial: string) => void;
  onRefresh: () => void;
  onCapture: () => void;
  onCancel?: () => void;
  sceneToolbarRef?: (element: HTMLDivElement | null) => void;
  inspectionStage?: string;
  inspectionElapsed?: number;
};

function stateLabel(state: string) {
  if (state === "device") return "已授权";
  if (state === "unauthorized") return "待授权";
  if (state === "offline") return "离线";
  return state;
}

export function AppHeader({
  homeMenu,
  inspectionActive,
  selectedSerial,
  devices,
  toolbarSerial,
  toolbarDevice,
  statusTone,
  runtimeError,
  probeError,
  loading,
  inspectionLoading,
  captureSerial,
  canSelectDevice,
  onBack,
  onSelectDevice,
  onRefresh,
  onCapture,
  onCancel,
  sceneToolbarRef,
  inspectionStage,
  inspectionElapsed,
}: Props) {
  const statusMessage = runtimeError || probeError;

  if (inspectionActive) return (
    <header className="inspection-header" aria-label="检查工作台工具栏">
      <div className="workbench-device-tools" role="group" aria-label="设备与采集">
        <button className="workbench-tool-button" type="button" onClick={onBack} aria-label={workbenchCommands.home.label} title={`${workbenchCommands.home.label} · ${commandShortcut("home")}`}>
          <AppIcon name="device" size={20} /><span>设备</span>
        </button>
        <div className="toolbar-device-control">
          <span className={`connection-dot ${statusTone}`} title={statusMessage || (captureSerial ? "设备已连接" : "等待设备")} aria-hidden="true" />
          <select id="device-select" className="device-select" aria-label="选择 Android 设备" title={statusMessage || (captureSerial ? "设备已连接；画面采集时间在画布下方" : "设备未连接；仍可查看已有快照")} disabled={!canSelectDevice} value={toolbarSerial} onChange={event => onSelectDevice(event.currentTarget.value)}>
            <option value="">{devices.length ? "选择设备" : "未发现设备"}</option>
            {devices.map(device => <option key={device.serial} value={device.serial} data-device-state={device.state} disabled={device.state !== "device"} className="device-option">{device.model ?? device.serial} · {stateLabel(device.state)}</option>)}
            {selectedSerial && !toolbarDevice && <option value={selectedSerial} data-device-state="history">{selectedSerial} · 历史快照</option>}
          </select>
        </div>
        <button className="workbench-tool-button refresh-button" type="button" onClick={onRefresh} disabled={loading} aria-label={workbenchCommands.refresh.label} title={`${workbenchCommands.refresh.label} · ${commandShortcut("refresh")}`}>
          <AppIcon name="refresh" size={18} className={loading ? "spinning" : ""} />
        </button>
        {inspectionLoading && <span className="workbench-capture-status" role="status" title={`${inspectionStage ?? "采集中"} · ${inspectionElapsed ?? 0}s`}>{inspectionStage ?? "采集中"} · {inspectionElapsed ?? 0}s</span>}
        {inspectionLoading ? <button className="workbench-tool-button workbench-cancel" type="button" onClick={onCancel} aria-label={workbenchCommands.cancel.label} title={`${workbenchCommands.cancel.label} · ${commandShortcut("cancel")} · ${inspectionElapsed ?? 0}s`}>
          <AppIcon name="stop" size={16} /><span>取消</span>
        </button> : <button className="workbench-tool-button capture-button" type="button" onClick={onCapture} disabled={!captureSerial || loading} aria-label={workbenchCommands.capture.label} title={`${workbenchCommands.capture.label} · ${commandShortcut("capture")}`}>
          <AppIcon name="camera" size={20} /><span>采集快照</span>
        </button>}
      </div>
      <div className="scene-toolbar-host workbench-scene-tools" ref={sceneToolbarRef} role="group" aria-label="工作台工具" />
    </header>
  );

  return <header className="topbar is-home">
    <div className="brand-lockup">
      <AppIcon name="hierarchy" size={24} className="brand-mark" />
      <h1>Android UI Inspector</h1>
    </div>
    {homeMenu}
  </header>;
}
