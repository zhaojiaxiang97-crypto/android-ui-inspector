import { colorAlias, colorHasExactHex, colorHex, colorRgba, parseInspectorColor,
  type ColorAliasPreference, type InspectorColorEncoding } from "../../shared/inspector-colors";

export function ColorProperty({ label, raw, encoding, aliases, onCopy, fallback = "—" }: {
  label: string; raw: string | null | undefined; encoding: InspectorColorEncoding;
  aliases: ColorAliasPreference; onCopy?: (label: string, value: string) => void; fallback?: string;
}) {
  const color = parseInspectorColor(raw, encoding), alias = color && colorAlias(color, aliases);
  const hex = color && colorHex(color), rgba = color && colorRgba(color), exact = color && colorHasExactHex(color);
  return <div className="inspector-color-property" data-color-label={label} data-color-valid={Boolean(color)}>
    <dt>{label}</dt>
    <dd>
      {color && <div className="inspector-color-heading">
        <span className="inspector-color-swatch" role="img" aria-label={`${label}色块，透明度保留`} title={rgba!}>
          <span style={{ backgroundColor: rgba! }} />
        </span>
        <span title={exact ? "CSS Hex：#RRGGBBAA，透明度在末尾" : "Hex 的透明度已取最近的 8 位值；RGBA 保留原始精度"}>{!exact && "≈ "}{hex}</span>
      </div>}
      {alias && <div className="inspector-color-alias" title="本机配置的精确颜色别名">{alias}</div>}
      <div className="inspector-color-raw">{color && (encoding === "android-argb" ? "ARGB " : "原 RGBA ")}{raw || fallback}</div>
      {color && <div className="inspector-color-alpha">透明度 {Math.round(color.alpha * 10000) / 100}%</div>}
      {onCopy && raw && <div className="inspector-color-actions">
        <button type="button" aria-label={`复制${label}原值`} title={raw} onClick={() => onCopy(`${label}原值`, raw)}>原值</button>
        {color && <>
          <button type="button" aria-label={`复制${label} Hex`} title={`${hex} · #RRGGBBAA${exact ? "" : "（透明度近似）"}`} onClick={() => onCopy(`${label} Hex`, hex!)}>Hex{!exact && " ≈"}</button>
          <button type="button" aria-label={`复制${label} RGBA`} title={rgba!} onClick={() => onCopy(`${label} RGBA`, rgba!)}>RGBA</button>
        </>}
      </div>}
    </dd>
  </div>;
}
