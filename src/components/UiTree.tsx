import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, SetStateAction } from "react";
import { nodeDisplayLabel, nodeShortClass } from "../../shared/tree-utils";
import { collapseTreeBranch, expandAncestors, indexTree, nearestVisibleId, scrollToTreeRow, TREE_ROW_HEIGHT, TREE_VIRTUAL_THRESHOLD, treeWindow, visibleTreeRows } from "../../shared/visible-tree";
import type { TreeRow } from "../../shared/visible-tree";
import type { UiNode } from "../../shared/types";

type UiTreeProps = {
  root: UiNode;
  filteredRoot: UiNode | null;
  filterActive: boolean;
  filterKey: string;
  selectedId: string | null;
  expanded: ReadonlySet<string>;
  revealRequest?: number;
  onExpandedChange: (next: SetStateAction<ReadonlySet<string>>) => void;
  onSelect: (node: UiNode) => void;
  onClearFilter: () => void;
};

const FILTER_EXPANDED: ReadonlySet<string> = new Set();

function treeNodeKind(node: UiNode, hasChildren: boolean) {
  if (node.clickable || node.focusable || node.scrollable) return "interactive";
  return hasChildren ? "container" : "leaf";
}

type RowProps = {
  row: TreeRow;
  domId: string;
  selected: boolean;
  active: boolean;
  expanded: boolean;
  filterActive: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
};

const UiTreeRow = memo(function UiTreeRow({ row, domId, selected, active, expanded, filterActive, onSelect, onToggle }: RowProps) {
  const { node, depth } = row;
  const hasChildren = node.children.length > 0;
  const shortClass = nodeShortClass(node);
  const label = nodeDisplayLabel(node);
  const hasSecondaryLabel = label !== shortClass;
  const kind = treeNodeKind(node, hasChildren);
  const muted = !node.visibleToUser || !node.enabled;
  // ponytail: cap deep indentation so Android trees stay readable in a narrow inspector rail.
  const indentation = 10 + Math.min(depth, 7) * 14;
  return (
    <div
      id={domId}
      role="treeitem"
      tabIndex={-1}
      data-tree-id={node.id}
      aria-level={depth + 1}
      aria-posinset={row.position}
      aria-setsize={row.setSize}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={selected}
      data-tree-kind={kind}
      className={`tree-row tree-kind-${kind} ${hasSecondaryLabel ? "has-secondary-label" : ""} ${muted ? "is-muted" : ""} ${selected ? "selected" : ""} ${active ? "active" : ""}`}
      style={{ paddingLeft: indentation }}
      title={`${nodeDisplayLabel(node)} · #${node.id} · 第 ${depth + 1} 层`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onSelect(node.id)}
    >
      <span
        aria-hidden="true"
        className={`tree-chevron ${hasChildren ? "has-children" : "leaf"} ${expanded ? "expanded" : ""}`}
        title={filterActive && hasChildren ? "筛选期间保持展开" : undefined}
        onClick={(event) => {
          if (!hasChildren) return;
          event.stopPropagation();
          onToggle(node.id);
        }}
      >{hasChildren ? (expanded ? "▾" : "▸") : ""}</span>
      <span className="tree-node-icon" aria-hidden="true" />
      <span className="tree-class">{shortClass}</span>
      {hasSecondaryLabel && <span className="tree-label">{label}</span>}
      {node.clickable && <span className="tree-flag" role="img" aria-label="可点击">tap</span>}
    </div>
  );
});

// The caller keys this component by inspection/history session, not by filter.
// Expansion belongs to the whole tree, never to rows that virtualization evicts.
export const UiTree = memo(function UiTree({ root, filteredRoot, filterActive, filterKey, selectedId, expanded, revealRequest = 0, onExpandedChange, onSelect, onClearFilter }: UiTreeProps) {
  const index = useMemo(() => indexTree(root), [root]);
  const [activeId, setActiveId] = useState<string | null>(selectedId);
  const [localReveal, setLocalReveal] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(450);
  const viewport = useRef<HTMLDivElement>(null);
  const pendingReveal = useRef<string | null>(null);
  const treeId = useId();
  const visibleExpansion = filterActive ? FILTER_EXPANDED : expanded;
  const rows = useMemo(() => visibleTreeRows(filteredRoot, visibleExpansion, filterActive), [filteredRoot, visibleExpansion, filterActive]);
  const positions = useMemo(() => new Map(rows.map((row, rowIndex) => [row.node.id, rowIndex])), [rows]);
  const resolvedActive = nearestVisibleId(activeId, index, positions) ?? rows[0]?.node.id ?? null;
  const range = treeWindow(rows.length, scrollTop, viewportHeight);
  const virtual = rows.length >= TREE_VIRTUAL_THRESHOLD;
  const start = virtual ? range.start : 0;
  const end = virtual ? range.end : rows.length;
  const activePosition = resolvedActive ? positions.get(resolvedActive) : undefined;
  const activeMounted = activePosition !== undefined && activePosition >= start && activePosition < end;
  const rowDomId = (id: string) => `${treeId}-${encodeURIComponent(id)}`;
  const allExpandedIds = useMemo(
    () => new Set([...index.values()].filter((row) => row.node.children.length > 0).map((row) => row.node.id)),
    [index],
  );

  useLayoutEffect(() => {
    const element = viewport.current!;
    const measure = () => setViewportHeight(element.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Only a new selection, explicit locate, or filter change reveals ancestors.
  // Ordinary scrolling/collapsing must not reopen a manually closed branch.
  useLayoutEffect(() => {
    const target = selectedId && index.has(selectedId) ? selectedId : root.id;
    onExpandedChange((previous) => expandAncestors(index, previous, target));
    setActiveId(target);
    pendingReveal.current = target;
  }, [index, root.id, selectedId, revealRequest, localReveal, filterKey, onExpandedChange]);

  useLayoutEffect(() => {
    const element = viewport.current!;
    let next = treeWindow(rows.length, element.scrollTop, element.clientHeight).top;
    const target = pendingReveal.current;
    if (target) {
      const position = positions.get(target);
      if (position !== undefined) {
        next = scrollToTreeRow(position, rows.length, next, element.clientHeight);
        pendingReveal.current = null;
      } else if (filterActive || !index.has(target)) {
        next = 0;
        pendingReveal.current = null;
      }
    }
    element.scrollTop = next;
    setScrollTop(next);
  }, [rows, positions, index, filterActive, filterKey, selectedId, revealRequest, localReveal, viewportHeight]);

  const select = useCallback((id: string) => {
    const entry = index.get(id);
    if (!entry) return;
    setActiveId(id);
    viewport.current?.focus({ preventScroll: true });
    // Return the complete original node, not a pruned filter copy.
    onSelect(entry.node);
    const element = viewport.current;
    const position = positions.get(id);
    if (element && position !== undefined) {
      element.scrollTop = scrollToTreeRow(position, rows.length, element.scrollTop, element.clientHeight);
      setScrollTop(element.scrollTop);
    }
  }, [index, onSelect, positions, rows.length]);

  const toggle = useCallback((id: string) => {
    viewport.current?.focus({ preventScroll: true });
    setActiveId(id);
    if (filterActive) return;
    onExpandedChange((previous) => {
      if (previous.has(id)) return collapseTreeBranch(previous, id);
      const next = new Set(previous);
      next.add(id);
      return next;
    });
  }, [filterActive, onExpandedChange]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || activePosition === undefined) return;
    const row = rows[activePosition];
    let target: TreeRow | undefined;
    switch (event.key) {
      case "ArrowDown": target = rows[Math.min(rows.length - 1, activePosition + 1)]; break;
      case "ArrowUp": target = rows[Math.max(0, activePosition - 1)]; break;
      case "Home": target = rows[0]; break;
      case "End": target = rows[rows.length - 1]; break;
      case "ArrowRight":
        if (row.node.children.length > 0) {
          if (!filterActive && !expanded.has(row.node.id)) toggle(row.node.id);
          else target = rows[activePosition + 1];
        }
        break;
      case "ArrowLeft":
        if (!filterActive && row.node.children.length > 0 && expanded.has(row.node.id)) toggle(row.node.id);
        else if (row.parentId) target = rows[positions.get(row.parentId)!];
        break;
      case "Enter": case " ": target = row; break;
      default: return;
    }
    event.preventDefault();
    if (target) select(target.node.id);
  };

  return (
    <div className="ui-tree" style={{ "--tree-row-height": `${TREE_ROW_HEIGHT}px` } as CSSProperties}>
      <div className="tree-toolbar">
        <div className="tree-toolbar-actions">
          <button className="tree-clear tree-expand-all" type="button" disabled={filterActive || rows.length === 0} onClick={() => onExpandedChange(allExpandedIds)}>全部展开</button>
          <button className="tree-clear tree-collapse-all" type="button" disabled={filterActive || rows.length === 0} onClick={() => onExpandedChange(new Set())}>全部折叠</button>
          <button className="tree-clear tree-locate" type="button" disabled={!selectedId || !index.has(selectedId)} onClick={() => { onClearFilter(); setLocalReveal((value) => value + 1); }}>定位选中</button>
        </div>
        <span className="tree-hint" title="方向键浏览和展开/折叠，Home/End 跳转首末行">{rows.length} 行{virtual ? " · 按需渲染" : ""}{filterActive ? " · 筛选展开" : ""}</span>
      </div>
      <div
        className="tree-scroll ui-tree-scroll"
        ref={viewport}
        role="tree"
        tabIndex={0}
        aria-label="UI hierarchy tree"
        aria-activedescendant={activeMounted && resolvedActive ? rowDomId(resolvedActive) : undefined}
        data-virtual={virtual}
        data-row-count={rows.length}
        data-window-start={start}
        data-window-end={end}
        onKeyDown={onKeyDown}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {rows.length > 0 ? (
          <div className="tree-rows" role="none" style={{ height: range.totalHeight }}>
            <div role="none" style={{ transform: `translateY(${start * TREE_ROW_HEIGHT}px)` }}>
              {rows.slice(start, end).map((row) => (
                <UiTreeRow key={row.node.id} row={row} domId={rowDomId(row.node.id)} selected={row.node.id === selectedId} active={row.node.id === resolvedActive} expanded={filterActive || expanded.has(row.node.id)} filterActive={filterActive} onSelect={select} onToggle={toggle} />
              ))}
            </div>
          </div>
        ) : (
          <div className="tree-empty">
            <p>没有匹配的 UI 节点</p>
            <button className="tree-clear" type="button" onClick={onClearFilter}>清除筛选</button>
          </div>
        )}
      </div>
    </div>
  );
});
