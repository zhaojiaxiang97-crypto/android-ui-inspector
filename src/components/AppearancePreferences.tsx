import { useState } from "react";
import { parseAppearancePreference, type AppearancePreference, type ResolvedAppearance } from "../../shared/appearance";

export function AppearancePreferences({ preference, resolved, onChange, saveError = false }: {
  preference: AppearancePreference; resolved: ResolvedAppearance;
  onChange?: (value: AppearancePreference) => boolean; saveError?: boolean;
}) {
  const [saved, setSaved] = useState<boolean | null>(null);
  return <section className="preferences-section preferences-appearance" aria-labelledby="preferences-appearance-title">
    <h3 id="preferences-appearance-title">外观</h3>
    <label className="preferences-field">界面外观
      <select aria-label="界面外观" aria-describedby="preferences-appearance-help" value={preference} disabled={!onChange}
        onChange={event => {
          const next = parseAppearancePreference(event.currentTarget.value);
          if (next && onChange) setSaved(onChange(next));
        }}>
        <option value="dark">深色</option>
        <option value="light">浅色</option>
        <option value="system">跟随系统</option>
      </select>
    </label>
    <p id="preferences-appearance-help">当前为{resolved === "dark" ? "深色" : "浅色"}。检查画布保持深灰，图片原色不变。</p>
    <p className={saveError || saved === false ? "preferences-error" : undefined} role="status">
      {saveError || saved === false ? "已应用到本次窗口，本机保存失败；重开后可能丢失。"
        : saved ? "外观已保存并生效。" : onChange ? "立即生效并保存在本机。" : "当前窗口不支持修改外观。"}
    </p>
  </section>;
}
