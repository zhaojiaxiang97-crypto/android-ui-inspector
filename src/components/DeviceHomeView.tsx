import { useEffect, useState } from "react";
import type { DeviceInfo } from "../../shared/types";
import type { HomeState } from "../../shared/device-state";
import { commandShortcut, workbenchCommands } from "../../shared/workbench-commands";
import { EntryDialog } from "./EntryDialog";

type Props = {
  state: HomeState;
  device: DeviceInfo | null;
  devices: DeviceInfo[];
  loading: boolean;
  inspectionLoading: boolean;
  canSelectDevice: boolean;
  error: string | null;
  checkedAt: Date | null;
  onStart: () => void;
  onRefresh: () => void;
  onSelectDevice: (serial: string) => void;
};

function emptyStateCopy(state: HomeState) {
  switch (state) {
    case "loading":
      return { title: "正在检查设备", description: "正在连接 ADB 并读取 Android 设备。" };
    case "adb-missing":
      return { title: "ADB 尚未准备好", description: "请确认 Android SDK Platform-Tools 已安装后重试。" };
    case "error":
      return { title: "连接出现问题", description: "无法读取设备列表，请检查 ADB 后重试。" };
    case "unauthorized":
      return { title: "等待设备授权", description: "请在手机上允许这台电脑进行 USB 调试。" };
    case "offline":
      return { title: "设备已离线", description: "请重新连接设备，确认 USB 调试已开启后刷新。" };
    case "no-device":
    default:
      return { title: "等待 Android 设备", description: "通过 USB 连接设备并开启 USB 调试。" };
  }
}

function deviceStateLabel(state: DeviceInfo["state"]) {
  if (state === "device") return "已授权";
  if (state === "unauthorized") return "待授权";
  return "离线";
}

export function DeviceHomeView({ state, device, devices, loading, inspectionLoading, canSelectDevice, error, checkedAt, onStart, onRefresh, onSelectDevice }: Props) {
  const [switchOpen, setSwitchOpen] = useState(false);
  const connected = state === "connected" && Boolean(device);
  const copy = emptyStateCopy(state);

  useEffect(() => {
    if (loading || inspectionLoading) setSwitchOpen(false);
  }, [loading, inspectionLoading]);

  return (
    <section className="home-view" aria-label="设备连接" data-state={state} aria-busy={loading}>
      <div className={`home-center-state state-${state} ${connected ? "is-connected" : "is-empty"}`}>
        <div className={`home-device-art ${connected ? "is-connected" : "is-empty"}`} aria-hidden="true">
          <div className="home-phone-shell">
            <span className="home-phone-camera" />
            <span className="home-phone-speaker" />
            <span className="home-phone-screen">
              {connected ? <><i /><i /><i /><i /></> : <b />}
            </span>
            <span className="home-phone-home-indicator" />
          </div>
        </div>

        {connected ? (
          <>
            <h2 title={device?.model ?? device?.serial ?? undefined}>{device?.model || device?.serial || "Android 设备"}</h2>
            <p className="home-device-platform">
              {device?.androidVersion ? `Android ${device.androidVersion}` : "Android"}
            </p>
            <div className="home-connection-status" role="status">
              <span className="home-status-dot ready" aria-hidden="true" />
              <span>设备已连接</span>
            </div>
          </>
        ) : (
          <>
            <h2 role="status" aria-live="polite">{copy.title}</h2>
            <p className="home-empty-description">{copy.description}</p>
            {device && (state === "unauthorized" || state === "offline") && <p className="home-target-name" title={device.serial}>{device.model || device.serial}</p>}
          </>
        )}
        <div className="home-actions">
          {connected ? <button className="home-primary-action capture-button" type="button" onClick={onStart} disabled={inspectionLoading || loading}
            title={`${workbenchCommands.capture.label} · ${commandShortcut("capture")}`}>
            {inspectionLoading ? "正在采集…" : workbenchCommands.capture.label}
          </button> : <button className="home-primary-action" type="button" onClick={onRefresh} disabled={loading || inspectionLoading}
            title={`${workbenchCommands.refresh.label} · ${commandShortcut("refresh")}`}>
            {loading ? "正在检查…" : workbenchCommands.refresh.label}
          </button>}
          <div className="home-secondary-actions">
            {connected && <button className="home-secondary-action" type="button" onClick={onRefresh} disabled={loading || inspectionLoading}>{workbenchCommands.refresh.label}</button>}
            {devices.length > 0 && <button className="home-secondary-action" type="button" onClick={() => setSwitchOpen(true)} disabled={!canSelectDevice}
              aria-haspopup="dialog" aria-expanded={switchOpen}>切换设备</button>}
          </div>
        </div>
        {error && !loading && <details className="home-connection-detail"><summary>连接详情</summary><p>{error}</p></details>}
        {checkedAt && !loading && <p className="home-check-time">最近检查 {checkedAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</p>}
      </div>
      {switchOpen && (
        <EntryDialog className="home-device-switcher" labelledBy="home-device-switcher-title" onClose={() => setSwitchOpen(false)}>
          <div className="home-device-switcher-card">
            <div className="home-device-switcher-heading">
              <div>
                <h3 id="home-device-switcher-title">选择设备</h3>
              </div>
              <button className="home-device-switcher-close" type="button" onClick={() => setSwitchOpen(false)} aria-label="关闭设备选择" autoFocus>×</button>
            </div>
            <div className="home-device-list">
              {devices.map((item) => (
                <button className={`home-device-option ${item.serial === device?.serial ? "selected" : ""}`} type="button" key={item.serial}
                  disabled={item.state !== "device" || !canSelectDevice} onClick={() => { onSelectDevice(item.serial); setSwitchOpen(false); }} title={`${item.serial} · ${deviceStateLabel(item.state)}`}>
                  <span className={`home-device-option-dot ${item.state}`} aria-hidden="true" />
                  <span className="home-device-option-copy">
                    <strong>{item.model || item.serial}</strong>
                    <span>{item.serial}</span>
                  </span>
                  <span className={`home-device-option-state ${item.state}`}>{deviceStateLabel(item.state)}</span>
                </button>
              ))}
            </div>
            {devices.length === 0 && <p className="home-device-switcher-empty">暂时没有可选择的设备。</p>}
          </div>
        </EntryDialog>
      )}
    </section>
  );
}
