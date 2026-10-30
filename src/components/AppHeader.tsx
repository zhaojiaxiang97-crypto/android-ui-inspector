import type { DeviceInfo } from "../../shared/types";
import { commandShortcut, workbenchCommands } from "../../shared/workbench-commands";

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
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
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
          <svg className={loading ? "spinning" : ""} viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 1-2.3-5.7" /></svg>
        </button>
        {inspectionLoading && <span className="workbench-capture-status" role="status" title={`${inspectionStage ?? "采集中"} · ${inspectionElapsed ?? 0}s`}>{inspectionStage ?? "采集中"} · {inspectionElapsed ?? 0}s</span>}
        {inspectionLoading ? <button className="workbench-tool-button workbench-cancel" type="button" onClick={onCancel} aria-label={workbenchCommands.cancel.label} title={`${workbenchCommands.cancel.label} · ${commandShortcut("cancel")} · ${inspectionElapsed ?? 0}s`}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1" /></svg><span>取消</span>
        </button> : <button className="workbench-tool-button capture-button" type="button" onClick={onCapture} disabled={!captureSerial || loading} aria-label={workbenchCommands.capture.label} title={`${workbenchCommands.capture.label} · ${commandShortcut("capture")}`}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h4l2-3h4l2 3h4v13H4z" /><circle cx="12" cy="13" r="3.5" /></svg><span>采集</span>
        </button>}
      </div>
      <div className="scene-toolbar-host workbench-scene-tools" ref={sceneToolbarRef} role="group" aria-label="画布工具栏" />
    </header>
  );

  return <header className="topbar is-home">
    <div className="brand-lockup">
      <div className="brand-mark" aria-hidden="true"><span /><span /></div>
      <h1>Android UI Inspector</h1>
    </div>
    <details className="toolbar-help-wrap" onKeyDown={event => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false;
        event.currentTarget.querySelector("summary")?.focus();
      }
    }}>
      <summary className="toolbar-help-button" aria-label="使用帮助" title="使用帮助">?</summary>
      <div className="toolbar-help-popover">
        <strong>连接 Android 设备</strong>
        <p>通过 USB 连接设备，开启 USB 调试，并在手机上允许这台电脑。</p>
        <p>打开要检查的 Debug App，再点击“{workbenchCommands.capture.label}”。</p>
      </div>
    </details>
  </header>;
}
