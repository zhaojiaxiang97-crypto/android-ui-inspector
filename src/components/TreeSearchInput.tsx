import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { treeSearchShortcut, type TreeSearchNavigation } from "../../shared/tree-search-navigation";
import type { UiNode } from "../../shared/types";
import { findTreeSearchSuggestions, indexTreeSearchSuggestions, MAX_TREE_SEARCH_SUGGESTIONS, type TreeSearchSuggestionIndex } from "../features/inspection/tree-search-suggestions";
import "../styles/tree-search-suggestions.css";
import "../styles/tree-round3.css";

type Props = {
  root: UiNode; snapshotKey: string | number; value: string;
  onChange: (value: string) => void; onClear: () => void; hasFilter: boolean; disabled?: boolean; searchNavigation?: TreeSearchNavigation;
};
const category = { text: "文本", resource: "资源 ID", class: "类型" };

export function TreeSearchInput({ root, snapshotKey, value, onChange, onClear, hasFilter, disabled, searchNavigation }: Props) {
  const inputRef = useRef<HTMLInputElement>(null), listRef = useRef<HTMLUListElement>(null), id = useId();
  const index = useMemo(() => indexTreeSearchSuggestions(root), [root, snapshotKey]);
  const result = useMemo(() => findTreeSearchSuggestions(index, value), [index, value]);
  const [openFor, setOpenFor] = useState<TreeSearchSuggestionIndex | null>(null);
  const [selection, setSelection] = useState<{ index: TreeSearchSuggestionIndex; query: string; position: number } | null>(null);
  const [composing, setComposing] = useState(false), composingRef = useRef(false);
  const open = !disabled && !composing && openFor === index && result.items.length > 0;
  const active = selection?.index === index && selection.query === value ? selection.position : -1;
  const activeItem = open && active >= 0 ? result.items[active] : null;
  function adopt(position: number) {
    const item = result.items[position];
    if (!item || composingRef.current) return;
    setOpenFor(null); setSelection(null); onChange(item.value);
    inputRef.current?.focus({ preventScroll: true });
  }
  useLayoutEffect(() => {
    if (activeItem) listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [activeItem, active]);
  return <div className="tree-search-control" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpenFor(null);
  }}>
    <input ref={inputRef} className="tree-search" type="search" role="combobox" value={value} disabled={disabled}
      autoComplete="off" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? id : undefined}
      aria-activedescendant={activeItem ? `${id}-${active}` : undefined}
      placeholder="搜索控件…" title="搜索文本、描述、资源 ID 或控件类型" aria-label="搜索 UI 节点"
      onFocus={() => setOpenFor(index)}
      onChange={event => { setSelection(null); setOpenFor(index); onChange(event.target.value); }}
      onCompositionStart={() => { composingRef.current = true; setComposing(true); setSelection(null); }}
      onCompositionEnd={() => { composingRef.current = false; setComposing(false); setOpenFor(index); }}
      onKeyDown={event => {
        if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        const direction = treeSearchShortcut(event.nativeEvent);
        if (direction && searchNavigation?.active) {
          event.preventDefault(); event.stopPropagation();
          setOpenFor(null); setSelection(null);
          if (!disabled && !searchNavigation.disabledReason) (direction < 0 ? searchNavigation.previous : searchNavigation.next)();
          return;
        }
        if (event.key === "Escape") {
          if (open) { event.preventDefault(); event.stopPropagation(); setOpenFor(null); setSelection(null); }
          else if (hasFilter) { event.preventDefault(); event.stopPropagation(); onClear(); }
          return;
        }
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          if (result.items.length) {
            event.preventDefault(); event.stopPropagation(); setOpenFor(index);
            const from = open ? active : -1;
            setSelection({ index, query: value, position: from < 0 ? (event.key === "ArrowDown" ? 0 : result.items.length - 1)
              : Math.max(0, Math.min(result.items.length - 1, from + (event.key === "ArrowDown" ? 1 : -1))) });
          } else if (event.key === "ArrowDown") {
            event.preventDefault(); event.currentTarget.closest(".tree-pane")?.querySelector<HTMLElement>('[role="tree"]')?.focus({ preventScroll: true });
          }
        } else if (event.key === "Enter" && activeItem) { event.preventDefault(); event.stopPropagation(); adopt(active); }
      }} />
    {searchNavigation?.active && <div className="tree-search-matches" role="group" aria-label="巡览搜索匹配">
      <span className="tree-search-match-position" role="status" aria-live="polite">{searchNavigation.position === null
        ? `共 ${searchNavigation.count} 个匹配` : `第 ${searchNavigation.position} 个 / 共 ${searchNavigation.count} 个`}</span>
      <div className="tree-search-match-actions">
        <button type="button" className="tree-search-previous" aria-label="上一个匹配" disabled={disabled || Boolean(searchNavigation.disabledReason)}
          title={searchNavigation.disabledReason ?? "上一个匹配 · Shift+Cmd/Ctrl+G"} onClick={() => { setOpenFor(null); searchNavigation.previous(); }}>‹</button>
        <button type="button" className="tree-search-next" aria-label="下一个匹配" disabled={disabled || Boolean(searchNavigation.disabledReason)}
          title={searchNavigation.disabledReason ?? "下一个匹配 · Cmd/Ctrl+G"} onClick={() => { setOpenFor(null); searchNavigation.next(); }}>›</button>
      </div>
    </div>}
    {open && <div className="tree-search-suggestions">
      <p>当前快照中的候选</p>
      <ul ref={listRef} id={id} role="listbox" aria-label="树搜索建议">
        {result.items.map((item, position) => <li id={`${id}-${position}`} key={item.key} role="option" aria-selected={active === position}
          title={`${category[item.kind]}：${item.value}\n${item.occurrences} 处使用此值`} onPointerDown={event => event.preventDefault()}
          onMouseMove={() => setSelection({ index, query: value, position })} onClick={() => adopt(position)}>
          <span className="tree-suggestion-category">{category[item.kind]}</span><strong>{item.label}</strong>
          <small>{item.occurrences} 处</small>{item.label !== item.value && <span className="tree-suggestion-detail">{item.value}</span>}
        </li>)}
      </ul>
      <p className="tree-suggestion-help">{result.limited ? `最多显示 ${MAX_TREE_SEARCH_SUGGESTIONS} 项，继续输入缩小范围` : "↑↓ 预选 · Enter 采用 · Esc 关闭"}</p>
    </div>}
  </div>;
}
