import { AppIcon } from "./AppIcon";
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
  preview?: { dataUrl: string; capturedAt: string } | null;
  onDiagnose?: () => void;
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

export function DeviceHomeView({ state, device, devices, loading, inspectionLoading, canSelectDevice, error, preview, onDiagnose, onStart, onRefresh, onSelectDevice }: Props) {
  const [switchOpen, setSwitchOpen] = useState(false);
  const connected = state === "connected" && Boolean(device);
  const copy = emptyStateCopy(state);
  const [failedPreview, setFailedPreview] = useState<string | null>(null);
  const showPreview = connected && preview && preview.dataUrl !== failedPreview;

  useEffect(() => {
    if (loading || inspectionLoading) setSwitchOpen(false);
  }, [loading, inspectionLoading]);

  return (
    <section className="home-view" aria-label="设备连接" data-state={state} aria-busy={loading}>
      <div className="home-launchpad">
      <div className={`home-center-state state-${state} ${connected ? "is-connected" : "is-empty"}`}>
        {connected ? <figure className={`home-target-preview ${showPreview ? "has-image" : ""}`}>
          {showPreview ? <img src={preview.dataUrl} alt="这台设备上次保存的画面" onError={() => setFailedPreview(preview.dataUrl)} />
            : <div className="home-preview-placeholder"><AppIcon name="device" size={40} /><span>准备采集画面</span></div>}
          {showPreview && <figcaption title={new Date(preview.capturedAt).toLocaleString("zh-CN")}>
            上次采集 · {new Date(preview.capturedAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })}
          </figcaption>}
        </figure> : <div className={`home-empty-symbol ${loading ? "is-loading" : ""}`} aria-hidden="true">
          <AppIcon name={loading ? "refresh" : state === "error" || state === "adb-missing" ? "alert" : "device"} size={32} className={loading ? "spinning" : ""} />
        </div>}

        {connected ? (
          <>
            <div className="home-connection-status" role="status">
              <span className="home-status-dot ready" aria-hidden="true" />
              <span>设备已连接</span>
            </div>
            <p className="home-start-hint">在手机上打开要检查的 Debug App</p>
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
            <AppIcon name="camera" size={16} />{inspectionLoading ? "正在采集…" : workbenchCommands.capture.label}
          </button> : <button className="home-primary-action" type="button" onClick={onRefresh} disabled={loading || inspectionLoading}
            title={`${workbenchCommands.refresh.label} · ${commandShortcut("refresh")}`}>
            <AppIcon name="refresh" size={16} className={loading ? "spinning" : ""} />{loading ? "正在检查…" : workbenchCommands.refresh.label}
          </button>}
          <div className="home-secondary-actions">
            {connected && <button className="home-secondary-action" type="button" onClick={onRefresh} disabled={loading || inspectionLoading}>{workbenchCommands.refresh.label}</button>}
            {devices.length > 0 && <button className="home-secondary-action" type="button" onClick={() => setSwitchOpen(true)} disabled={!canSelectDevice}
              aria-haspopup="dialog" aria-expanded={switchOpen}>切换设备{devices.length > 1 ? ` · ${devices.length}` : ""}</button>}
          </div>
        </div>
        {error && !loading && <details className="home-connection-detail"><summary>连接详情</summary><p>{error}</p></details>}
      </div>
      <details className="home-connection-help" onKeyDown={event => {
        if (event.key !== "Escape") return;
        event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false;
        event.currentTarget.querySelector("summary")?.focus();
      }}>
        <summary><AppIcon name="help" size={14} />连接遇到问题？</summary>
        <div><p>通过 USB 连接设备，开启 USB 调试，并在手机上允许这台电脑。</p>
          <p>打开要检查的 Debug App，再点击“采集当前画面”。</p>
          {onDiagnose && <button className="home-diagnose-action" type="button" onClick={onDiagnose}>打开连接诊断</button>}</div>
      </details>
      </div>
      {switchOpen && (
        <EntryDialog className="home-device-switcher" labelledBy="home-device-switcher-title" onClose={() => setSwitchOpen(false)}>
          <div className="home-device-switcher-card">
            <div className="home-device-switcher-heading">
              <div>
                <h3 id="home-device-switcher-title">选择设备</h3>
              </div>
              <button className="home-device-switcher-close" type="button" onClick={() => setSwitchOpen(false)} aria-label="关闭设备选择" autoFocus><AppIcon name="close" size={14} /></button>
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
