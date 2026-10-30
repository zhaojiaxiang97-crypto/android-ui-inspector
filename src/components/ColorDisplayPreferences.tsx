import { COLOR_FORMAT_LABELS, parseColorDisplayFormat, type ColorDisplayFormat } from "../../shared/color-display";

export function ColorDisplayPreferences({ format, onChange, saveError = false }: {
  format: ColorDisplayFormat; onChange?: (value: ColorDisplayFormat) => boolean; saveError?: boolean;
}) {
  return <section className="preferences-section preferences-color-display" aria-labelledby="preferences-color-display-title">
    <h3 id="preferences-color-display-title">颜色显示</h3>
    <label className="preferences-field">默认颜色格式
      <select aria-label="默认颜色格式" value={format} disabled={!onChange} onChange={event => {
        const next = parseColorDisplayFormat(event.currentTarget.value); if (next) onChange?.(next);
      }}>{Object.entries(COLOR_FORMAT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
    </label>
    <p>只改变显示和复制格式。Hex 的透明度在末尾；无法精确表示时保留近似提示，原值在详情中。</p>
    <p className={saveError ? "preferences-error" : undefined} role="status">{saveError
      ? "已应用到本次窗口，本机保存失败；重开后可能丢失。" : "立即生效并保存在本机。"}</p>
  </section>;
}
