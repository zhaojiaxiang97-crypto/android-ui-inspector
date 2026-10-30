import { useLayoutEffect, useRef, useState } from "react";
import { countDebugTreeNodes, debugFieldCopyValue, debugFieldDisplayValue, debugFieldRawValue, debugFieldSearchValues, debugFieldTypeLabel,
  type DebugField, type DebugTreeNode } from "../../shared/debug-metadata";
import "../styles/debug-metadata-tree.css";
import { LongTextValue } from "./LongTextValue";

export type DebugMetadataFieldsProps = {
  fields: DebugField[];
  groupLabel?: string;
  pathPrefix?: string;
  query?: string;
  /** Stable for the source root, node and image session; independent of search query. */
  scope: object | string | null;
  revealRequest?: { id: string; revision: number } | null;
  onCopyValue?: (label: string, value: string) => void;
};
function CopyIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="5" y="5" width="8" height="8" rx="1" /><path d="M10 3H3v7" /></svg>;
}

/** All real rows remain in the DOM while folded so the inspector's existing index can read them. */
export function DebugMetadataFields({ fields, groupLabel, pathPrefix = "", query = "", scope, revealRequest, onCopyValue }: DebugMetadataFieldsProps) {
  const listRef = useRef<HTMLDListElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [searchOverrides, setSearchOverrides] = useState<Map<string, boolean>>(() => new Map());
  const search = query.toLocaleLowerCase().trim();
  useLayoutEffect(() => { setExpanded(new Set()); }, [scope]);
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
      event.stopPropagation(); event.preventDefault(); onCopyValue(field.label, debugFieldCopyValue(field));
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
    const row = <><span className="inspector-debug-tree-name" title={path}>{item.label}<small>{debugFieldTypeLabel(item.type)}</small></span>
      {displayValue(item, "inspector-debug-tree-value inspector-business-value")}{copy(item, labelPath)}</>;
    if (!item.children.length) return <dl key={path} className="inspector-property-list inspector-debug-tree-leaf"><div data-debug-path={path}
      data-inspector-value={debugFieldRawValue(item)} data-inspector-terms={terms.join(" ")}>
      <dt title={path}>{item.label}<small>{debugFieldTypeLabel(item.type)}</small></dt><dd className="inspector-copyable-value">{displayValue(item)}{copy(item, labelPath)}</dd>
    </div></dl>;
    const isOpen = open(path, contains([...terms, ...treeTerms(item.children, path)]));
    return <details key={path} className="inspector-debug-tree-node" data-debug-path={path} open={isOpen}
      onClick={event => summaryToggle(event, path, isOpen)}>
      <summary data-debug-path={path} data-inspector-label={item.label} data-inspector-value={debugFieldRawValue(item)} data-inspector-terms={terms.join(" ")}>{row}</summary>
      <div className="inspector-debug-tree-children">{nodes(item.children, path, labelPath)}</div>
    </details>;
  });
  return <dl ref={listRef} className="inspector-property-list inspector-debug-fields">{fields.map(field => {
    const path = pathPrefix ? `${pathPrefix}/${field.key}` : field.key;
    const tree = field.type === "tree";
    const terms = debugFieldSearchValues(field, pathPrefix);
    const isOpen = open(path, contains(terms));
    return <div key={field.key} className={tree ? "inspector-debug-tree-field" : undefined} data-debug-field={field.key}
      data-debug-path={path} data-inspector-value={debugFieldRawValue(field)} data-inspector-terms={terms.join(" ")}>
      <dt title={path}>{field.label}<small>{debugFieldTypeLabel(field.type)}</small></dt>
      <dd className="inspector-copyable-value">{displayValue(field)}{copy(field)}</dd>
      {field.type === "tree" && <details className="inspector-debug-tree-root" data-debug-path={path} open={isOpen}
        onClick={event => summaryToggle(event, path, isOpen)}><summary title={path}>查看分层信息 · {countDebugTreeNodes(field.value)} 项</summary>
        <div className="inspector-debug-tree-children">{nodes(field.value, path, field.label)}</div>
      </details>}
    </div>;
  })}</dl>;
}
