import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { countDebugTreeNodes, debugFieldCopyValue, debugFieldDisplayValue, debugFieldRawValue, debugFieldSearchValues, debugFieldTypeLabel,
  type DebugField, type DebugTreeNode } from "../../shared/debug-metadata";
import "../styles/debug-metadata-tree.css";
import "../styles/debug-metadata-reading.css";
import "../styles/entry.css";
import { LongTextValue } from "./LongTextValue";
import { EntryDialog } from "./EntryDialog";
import { debugTreeBranchCopyValue } from "../features/inspection/debug-tree-reading";

export type DebugMetadataFieldsProps = {
  fields: DebugField[];
  groupLabel?: string;
  pathPrefix?: string;
  query?: string;
  /** Stable for the source root, node and image session; independent of search query. */
  scope: object | string | null;
  revealRequest?: { id: string; revision: number } | null;
  onCopyValue?: (label: string, value: string) => void;
  context?: { nodeName?: string; source?: string };
  disabled?: boolean;
  /** Used by the independent reader, which keeps its own search and folds. */
  reading?: boolean;
};
function CopyIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="5" y="5" width="8" height="8" rx="1" /><path d="M10 3H3v7" /></svg>;
}

/** All real rows remain in the DOM while folded so the inspector's existing index can read them. */
export function DebugMetadataFields({ fields, groupLabel, pathPrefix = "", query = "", scope, revealRequest, onCopyValue, context, disabled = false, reading = false }: DebugMetadataFieldsProps) {
  const listRef = useRef<HTMLDListElement>(null);
  const initialExpanded = () => new Set(reading ? fields.filter(field => field.type === "tree").map(field => pathPrefix ? `${pathPrefix}/${field.key}` : field.key) : []);
  const [expanded, setExpanded] = useState<Set<string>>(initialExpanded);
  const [searchOverrides, setSearchOverrides] = useState<Map<string, boolean>>(() => new Map());
  const [reader, setReader] = useState<{ field: DebugField; fields: DebugField[]; scope: typeof scope } | null>(null);
  const current = useRef({ fields, scope, disabled, onCopyValue }); current.current = { fields, scope, disabled, onCopyValue };
  const validSource = () => current.current.scope === scope && current.current.fields === fields;
  const copyValue = (label: string, value: string) => { if (validSource()) current.current.onCopyValue?.(label, value); };
  const search = query.toLocaleLowerCase().trim();
  useLayoutEffect(() => { setExpanded(initialExpanded()); }, [scope]);
  useLayoutEffect(() => { setReader(null); }, [scope, fields, disabled]);
  useLayoutEffect(() => { setSearchOverrides(new Map()); }, [search, scope]);
  useLayoutEffect(() => {
    if (!search || !revealRequest || !listRef.current) return;
    // Do not interpolate caller IDs into a selector. Only current rendered properties participate.
    const target = [...listRef.current.querySelectorAll<HTMLElement>("[data-inspector-property]")]
      .find(row => row.dataset.inspectorProperty === revealRequest.id);
    if (!target) return;
    const parents: string[] = [];
    for (let parent = target.parentElement; parent && parent !== listRef.current; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement && parent.dataset.debugPath) parents.push(parent.dataset.debugPath);
    }
    if (parents.length) setSearchOverrides(current => {
      const next = new Map(current); parents.forEach(path => next.set(path, true)); return next;
    });
  }, [search, scope, revealRequest]);
  const contains = (terms: string[]) => Boolean(search && terms.some(term => term.toLocaleLowerCase().includes(search)));
  const open = (path: string, auto: boolean) => search ? searchOverrides.get(path) ?? auto : expanded.has(path);
  const toggle = (path: string, isOpen: boolean) => {
    if (search) setSearchOverrides(current => new Map(current).set(path, !isOpen));
    else setExpanded(current => { const next = new Set(current); if (isOpen) next.delete(path); else next.add(path); return next; });
  };
  const copy = (field: DebugField | DebugTreeNode, label = field.label) => onCopyValue && <button className="inspector-field-copy" type="button"
    aria-label={`复制${groupLabel ? `${groupLabel}·` : ""}${label}`} title="复制原始值" onClick={event => {
      event.stopPropagation(); event.preventDefault(); copyValue(field.label, debugFieldCopyValue(field));
    }}><CopyIcon /></button>;
  const displayValue = (field: DebugField | DebugTreeNode, className = "inspector-business-value") => field.type === "string" && field.value !== ""
    ? <LongTextValue label={field.label} value={field.value} className={className} />
    : <span className={className}>{debugFieldDisplayValue(field)}</span>;
  const scalarTerms = (field: DebugTreeNode, path: string) => [path, field.key, field.label, field.type, debugFieldTypeLabel(field.type),
    debugFieldRawValue(field), debugFieldDisplayValue(field), field.value === "" ? "空字符串 empty ∅" : ""];
  const treeTerms = (nodes: DebugTreeNode[], prefix: string): string[] => nodes.flatMap(node => {
    const path = `${prefix}/${node.key}`;
    return [...scalarTerms(node, path), ...treeTerms(node.children, path)];
  });
  const summaryToggle = (event: React.MouseEvent<HTMLDetailsElement>, path: string, isOpen: boolean) => {
    const summary = event.target instanceof Element ? event.target.closest("summary") : null;
    if (summary?.parentElement !== event.currentTarget) return;
    event.preventDefault(); toggle(path, isOpen);
  };
  const nodes = (items: DebugTreeNode[], prefix: string, labels: string): React.ReactNode => items.map(item => {
    const path = `${prefix}/${item.key}`, labelPath = `${labels}·${item.label}`, terms = scalarTerms(item, path);
    const row = <><span className="inspector-debug-tree-name" title={path}>{item.label}<small>{debugFieldTypeLabel(item.type)}</small>
      {reading && <small className="inspector-debug-tree-path">{path}</small>}</span>
      {displayValue(item, "inspector-debug-tree-value inspector-business-value")}{copy(item, labelPath)}
      {reading && onCopyValue && <button className="inspector-debug-branch-copy" type="button" aria-label={`复制${labelPath}完整分支`}
        title="复制当前字段、类型和全部子字段" onClick={event => { event.preventDefault(); event.stopPropagation(); copyValue(`${labelPath}分支`, debugTreeBranchCopyValue(item)); }}>复制分支</button>}</>;
    if (!item.children.length) return <dl key={path} className="inspector-property-list inspector-debug-tree-leaf"><div data-debug-path={path} className={reading && contains(terms) ? "inspector-debug-match" : undefined}
      data-inspector-value={debugFieldRawValue(item)} data-inspector-terms={terms.join(" ")}>
      <dt title={path}>{item.label}<small>{debugFieldTypeLabel(item.type)}</small>{reading && <small className="inspector-debug-tree-path">{path}</small>}</dt><dd className="inspector-copyable-value">{displayValue(item)}{copy(item, labelPath)}</dd>
    </div></dl>;
    const isOpen = open(path, contains([...terms, ...treeTerms(item.children, path)]));
    return <details key={path} className="inspector-debug-tree-node" data-debug-path={path} open={isOpen}
      onClick={event => summaryToggle(event, path, isOpen)}>
      <summary className={reading && contains(terms) ? "inspector-debug-match" : undefined} data-debug-path={path} data-inspector-label={item.label} data-inspector-value={debugFieldRawValue(item)} data-inspector-terms={terms.join(" ")}>{row}</summary>
      <div className="inspector-debug-tree-children">{nodes(item.children, path, labelPath)}</div>
    </details>;
  });
  return <><dl ref={listRef} className="inspector-property-list inspector-debug-fields">{fields.map(field => {
    const path = pathPrefix ? `${pathPrefix}/${field.key}` : field.key;
    const tree = field.type === "tree";
    const terms = debugFieldSearchValues(field, pathPrefix);
    const isOpen = open(path, contains(terms));
    return <div key={field.key} className={tree ? "inspector-debug-tree-field" : undefined} data-debug-field={field.key}
      data-debug-path={path} data-inspector-value={debugFieldRawValue(field)} data-inspector-terms={terms.join(" ")}>
      <dt title={path}>{field.label}<small>{debugFieldTypeLabel(field.type)}</small></dt>
      <dd className="inspector-copyable-value">{displayValue(field)}{copy(field)}</dd>
      {tree && !reading && <div className="inspector-debug-reader-entry"><button type="button" disabled={disabled}
        aria-label={`展开阅读${groupLabel ? `${groupLabel}·` : ""}${field.label}`} onClick={() => {
          if (validSource() && !current.current.disabled) setReader({ field, scope, fields });
        }}>展开阅读</button></div>}
      {field.type === "tree" && <details className="inspector-debug-tree-root" data-debug-path={path} open={isOpen}
        onClick={event => summaryToggle(event, path, isOpen)}><summary title={path}>查看分层信息 · {countDebugTreeNodes(field.value)} 项</summary>
        <div className="inspector-debug-tree-children">{nodes(field.value, path, field.label)}</div>
      </details>}
    </div>;
  })}</dl>
    {reader && !disabled && reader.scope === scope && reader.fields === fields && fields.includes(reader.field) && createPortal(<DebugMetadataReader
      field={reader.field} groupLabel={groupLabel} pathPrefix={pathPrefix} context={context} scope={scope} onClose={() => setReader(null)}
      onCopyValue={onCopyValue ? (label, value) => { if (!current.current.disabled) copyValue(label, value); } : undefined} />, document.body)}
  </>;
}

function DebugMetadataReader({ field, groupLabel, pathPrefix, context, scope, onClose, onCopyValue }: {
  field: DebugField; groupLabel?: string; pathPrefix: string; context?: DebugMetadataFieldsProps["context"];
  scope: DebugMetadataFieldsProps["scope"]; onClose: () => void; onCopyValue?: DebugMetadataFieldsProps["onCopyValue"];
}) {
  const [search, setSearch] = useState("");
  const fields = useMemo(() => [field], [field]);
  const heading = useId(), path = pathPrefix ? `${pathPrefix}/${field.key}` : field.key;
  return <EntryDialog className="debug-metadata-reader" labelledBy={heading} onClose={onClose}>
    <div className="entry-dialog-heading"><h2 id={heading}>{field.label}</h2><button type="button" className="entry-dialog-close" aria-label="关闭分层信息阅读" onClick={onClose}>×</button></div>
    <div className="debug-metadata-reader-context"><p>{context?.nodeName || "当前控件"} · {groupLabel || "业务信息"} · {debugFieldTypeLabel(field.type)}</p>
      <code>{path}</code><p>来源：{context?.source || "Debug SDK · 显式登记 · 已采集值"}</p></div>
    <div className="debug-metadata-reader-tools"><label>搜索分层信息<input type="search" aria-label="搜索分层信息" value={search}
      onChange={event => setSearch(event.currentTarget.value)} onKeyDown={event => {
        if (event.key === "Escape" && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
      }} /></label>
      {onCopyValue && <button type="button" onClick={() => onCopyValue(field.label, debugFieldCopyValue(field))}>复制完整分层原值</button>}
    </div>
    {search.trim() && <p className="debug-metadata-reader-search-status" role="status">{debugFieldSearchValues(field, pathPrefix).some(value => value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
      ? "相关字段已标记，匹配分支已展开" : "没有匹配字段"}</p>}
    <div className="debug-metadata-reader-body"><DebugMetadataFields fields={fields} groupLabel={groupLabel} pathPrefix={pathPrefix} scope={scope}
      query={search} onCopyValue={onCopyValue} reading /></div>
  </EntryDialog>;
}
