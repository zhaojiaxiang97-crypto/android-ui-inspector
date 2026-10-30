import type { InspectionMode } from "../../shared/inspection-mode";
import type { InspectionModeSettingsState } from "../features/inspection/inspection-mode-settings";

export type InspectionModePreference = InspectionModeSettingsState & {
  setMode(mode: InspectionMode): Promise<void>;
  reload(): Promise<void>;
};
export function InspectionModePreferences({ preference }: { preference?: InspectionModePreference }) {
  const disabled = !preference?.available || !preference.loaded || preference.loading || preference.saving || preference.busy;
  const status = !preference?.available ? "当前运行环境不支持修改采集模式，请在新版桌面应用中设置。"
    : preference.loading ? "正在读取采集设置…"
    : !preference.loaded ? "尚未读取到采集设置，暂时不能修改。"
    : preference.saving ? "正在保存采集设置…"
    : preference.busy ? "请等待采集、刷新或自动调试结束后再修改。"
    : preference.mode === "sdk-enhanced" ? "SDK 增强已开启。切换后重新采集，才能使用新模式。"
    : "当前使用标准采集，无需接入 SDK。";
  return <section className="preferences-section" aria-labelledby="preferences-capture">
    <h3 id="preferences-capture">采集方式</h3>
    <label className="preferences-field">启用 SDK 增强
      <input type="checkbox" aria-label="启用 SDK 增强" aria-describedby="sdk-enhancement-help sdk-enhancement-status"
        checked={preference?.mode === "sdk-enhanced"} disabled={disabled}
        onChange={event => { void preference?.setMode(event.currentTarget.checked ? "sdk-enhanced" : "standard"); }} />
    </label>
    <p id="sdk-enhancement-help">适用于已接入 Inspector SDK 的 Debug App，可读取更多画面和业务信息。</p>
    <p id="sdk-enhancement-status" role="status">{status}</p>
    {preference?.error && <p className="preferences-error" role="alert">{preference.error}</p>}
    {preference?.available && !preference.loaded && !preference.loading && <div className="preferences-actions">
      <button type="button" onClick={() => { void preference.reload(); }}>重新读取设置</button>
    </div>}
    <details className="preferences-sdk-help">
      <summary>SDK 接入说明</summary>
      <p>由应用开发者在 Debug 构建中接入本项目的 inspector-sdk，按 Android 接入说明配置依赖，Release 构建不包含 SDK。普通应用可直接使用标准采集。</p>
      <p>开启增强后，在设备上打开已接入 SDK 的 Debug App，再采集当前画面。设置会保存在本机；已有快照和图片继续保留。</p>
    </details>
  </section>;
}
