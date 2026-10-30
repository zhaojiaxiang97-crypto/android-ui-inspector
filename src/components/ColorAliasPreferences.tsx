import { useState } from "react";
import { colorAliasText, MAX_COLOR_ALIAS_TEXT_LENGTH, parseColorAliasText, type ColorAliasPreference } from "../../shared/inspector-colors";

export function ColorAliasPreferences({ aliases, onSave }: { aliases: ColorAliasPreference; onSave: (value: ColorAliasPreference) => boolean }) {
  const [text, setText] = useState(() => colorAliasText(aliases));
  const [status, setStatus] = useState<string | null>(null);
  const { preference, error } = parseColorAliasText(text);
  return <section className="preferences-section preferences-colors" aria-labelledby="preferences-colors-title">
    <h3 id="preferences-colors-title">颜色别名</h3>
    <label className="preferences-class-field">颜色 = 别名
      <textarea aria-label="颜色别名" aria-describedby="preferences-colors-help" rows={3} maxLength={MAX_COLOR_ALIAS_TEXT_LENGTH}
        placeholder={"#0066FF = 品牌主色\nrgba(0, 102, 255, 0.5) = 半透明主色"} value={text}
        onChange={event => { setText(event.currentTarget.value); setStatus(null); }} />
    </label>
    <p id="preferences-colors-help">每行一项，最多 32 项。Hex 为 #RRGGBB 或 #RRGGBBAA（透明度在末尾），也可粘贴属性栏复制的 RGBA；精确匹配颜色及透明度。</p>
    {error && <p className="preferences-error" role="alert">{error}</p>}
    <div className="preferences-actions preferences-color-actions">
      <button type="button" disabled={!preference} onClick={() => {
        if (preference) setStatus(onSave(preference) ? "颜色别名已保存并生效。" : "已应用到本次窗口，但本机保存失败；重开后可能丢失。");
      }}>保存颜色别名</button>
      <button type="button" onClick={() => { setText(""); setStatus(null); }}>清空别名</button>
    </div>
    <p role="status">{status ?? "别名保存在本机；清空后保存即可移除。快照仍保留原始颜色。"}</p>
  </section>;
}
