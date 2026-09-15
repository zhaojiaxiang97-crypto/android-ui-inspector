import { useEffect, useState } from "react";
import type { DeviceInfo } from "../../shared/types";
import type { HomeState } from "../../shared/device-state";

type Props = {
  state: HomeState;
  device: DeviceInfo | null;
  devices: DeviceInfo[];
  loading: boolean;
  inspectionLoading: boolean;
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

export function DeviceHomeView({ state, device, devices, loading, inspectionLoading, onStart, onRefresh, onSelectDevice }: Props) {
  const [switchOpen, setSwitchOpen] = useState(false);
  const connected = state === "connected" && Boolean(device);
  const copy = emptyStateCopy(state);

  useEffect(() => {
    if (!connected) setSwitchOpen(false);
  }, [connected]);

  useEffect(() => {
    if (!switchOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSwitchOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [switchOpen]);

  return (
    <section className="home-view" aria-label="设备连接">
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
            <h2>{device?.model ?? "Android device"}</h2>
            <p className="home-device-platform">
              {device?.androidVersion ? `Android ${device.androidVersion}` : "Android"}
            </p>
            <div className="home-connection-status" role="status">
              <span className="home-status-dot ready" aria-hidden="true" />
              <span>设备已连接</span>
            </div>
            <div className="home-actions">
              <button className="home-primary-action" type="button" onClick={onStart} disabled={inspectionLoading || loading}>
                {inspectionLoading ? "正在检查…" : "开始检查"}
              </button>
              <button className="home-secondary-action" type="button" onClick={() => setSwitchOpen(true)} aria-haspopup="dialog" aria-expanded={switchOpen}>切换设备</button>
            </div>
          </>
        ) : (
          <>
            <h2>{copy.title}</h2>
            <p className="home-empty-description">{copy.description}</p>
            <button className="home-primary-action" type="button" onClick={onRefresh} disabled={loading}>
              {loading ? "检查中…" : "刷新设备"}
            </button>
          </>
        )}
      </div>
      {switchOpen && (
        <div className="home-device-switcher" role="dialog" aria-modal="true" aria-labelledby="home-device-switcher-title">
          <div className="home-device-switcher-card">
            <div className="home-device-switcher-heading">
              <div>
                <p className="section-kicker">TARGET DEVICE</p>
                <h3 id="home-device-switcher-title">选择设备</h3>
              </div>
              <button className="home-device-switcher-close" type="button" onClick={() => setSwitchOpen(false)} aria-label="关闭设备选择">×</button>
            </div>
            <div className="home-device-list">
              {devices.map((item) => (
                <button className={`home-device-option ${item.serial === device?.serial ? "selected" : ""}`} type="button" key={item.serial} onClick={() => { onSelectDevice(item.serial); setSwitchOpen(false); }}>
                  <span className={`home-device-option-dot ${item.state}`} aria-hidden="true" />
                  <span className="home-device-option-copy">
                    <strong>{item.model ?? "Android device"}</strong>
                    <span>{item.serial}</span>
                  </span>
                  <span className={`home-device-option-state ${item.state}`}>{deviceStateLabel(item.state)}</span>
                </button>
              ))}
            </div>
            {devices.length === 0 && <p className="home-device-switcher-empty">暂时没有可选择的设备。</p>}
          </div>
        </div>
      )}
    </section>
  );
}
