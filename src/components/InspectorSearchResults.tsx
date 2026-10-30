import { useLayoutEffect, useRef } from "react";
import { inspectorSearchPreview, type InspectorSearchPage, type InspectorSearchProperty } from "../../shared/inspector-search";
import "../styles/inspector-search.css";

export function InspectorSearchResults<T extends InspectorSearchProperty>({ results, total, onLocate, onCopy, onClear, page, onPageChange }: {
  results: readonly T[]; total: number; onLocate: (property: T) => void;
  onCopy?: (label: string, value: string) => void; onClear: () => void;
  page?: InspectorSearchPage; onPageChange?: (index: number) => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => { if (list.current) list.current.scrollTop = 0; }, [page?.index]);
  return <section className="inspector-search-results" aria-label="属性搜索结果" onKeyDown={event => {
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      if (!event.nativeEvent.isComposing && event.keyCode !== 229) onClear();
    }
  }}>
    <p role="status">{page && total ? `第 ${page.start}–${page.end} 项，共 ${total} 项` : `匹配 ${total} 项${total > results.length ? `，显示前 ${results.length} 项` : ""}`}</p>
    {page && page.count > 1 && onPageChange && <nav className="inspector-search-pages" aria-label="属性搜索分页">
      <button type="button" disabled={page.index === 0} onClick={() => onPageChange(page.index - 1)}>上一页</button>
      <span>{page.index + 1} / {page.count}</span>
      <button type="button" disabled={page.index + 1 >= page.count} onClick={() => onPageChange(page.index + 1)}>下一页</button>
    </nav>}
    {results.length > 0 && <ul ref={list}>{results.map(property => <li key={property.id}>
      <button className="inspector-search-result" type="button" data-search-result={property.id}
        aria-label={`定位${property.section}·${property.label}`} title={`${property.section} · ${property.label}\n${property.value === "" ? "（空字符串）" : property.value}`}
        onClick={() => onLocate(property)} onKeyDown={event => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (!event.nativeEvent.isComposing && event.keyCode !== 229) onLocate(property);
          }
        }}>
        <small>{property.section}</small><strong>{property.label}</strong>
        <span>{inspectorSearchPreview(property.value)}</span>
      </button>
      {onCopy && <button className="inspector-search-result-copy" type="button" aria-label={`复制${property.section}·${property.label}搜索结果原值`}
        title="复制完整原值" onClick={() => onCopy(property.label, property.value)}>复制</button>}
    </li>)}</ul>}
  </section>;
}
