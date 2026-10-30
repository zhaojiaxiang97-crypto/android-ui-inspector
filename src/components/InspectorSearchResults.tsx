import { inspectorSearchPreview, type InspectorSearchProperty } from "../../shared/inspector-search";
import "../styles/inspector-search.css";

export function InspectorSearchResults<T extends InspectorSearchProperty>({ results, total, onLocate, onCopy, onClear }: {
  results: readonly T[]; total: number; onLocate: (property: T) => void;
  onCopy?: (label: string, value: string) => void; onClear: () => void;
}) {
  return <section className="inspector-search-results" aria-label="属性搜索结果" onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClear(); }
  }}>
    <p role="status">匹配 {total} 项{total > results.length ? `，显示前 ${results.length} 项` : ""}</p>
    {results.length > 0 && <ul>{results.map(property => <li key={property.id}>
      <button className="inspector-search-result" type="button" data-search-result={property.id}
        aria-label={`定位${property.section}·${property.label}`} title={`${property.section} · ${property.label}\n${property.value === "" ? "（空字符串）" : property.value}`}
        onClick={() => onLocate(property)} onKeyDown={event => {
          if (event.key === "Enter") { event.preventDefault(); onLocate(property); }
        }}>
        <small>{property.section}</small><strong>{property.label}</strong>
        <span>{inspectorSearchPreview(property.value)}</span>
      </button>
      {onCopy && <button className="inspector-search-result-copy" type="button" aria-label={`复制${property.section}·${property.label}搜索结果原值`}
        title="复制完整原值" onClick={() => onCopy(property.label, property.value)}>复制</button>}
    </li>)}</ul>}
  </section>;
}
