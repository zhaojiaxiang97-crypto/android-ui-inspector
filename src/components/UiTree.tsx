import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, SetStateAction } from "react";
import { nodeDisplayLabel, nodeShortClass, treeNodeKind } from "../../shared/tree-utils";
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

const TREE_ICONS: Record<ReturnType<typeof treeNodeKind>, { label: string; path: string }> = {
  activity: { label: "应用页面", path: "M2 2.5h12v11H2zM2 5.5h12M4 4h.01M6 4h.01M5 8h6M5 10.5h4" },
  window: { label: "窗口", path: "M3.5 1.5h11v10M1.5 4.5h10v10h-10zM1.5 7h10" },
  linear: { label: "线性布局", path: "M2 2h12v12H2zM2 6h12M2 10h12" },
  frame: { label: "叠放布局", path: "M2 2h9v9H2zM5 5h9v9H5z" },
  constraint: { label: "约束 / 相对布局", path: "M5.5 5.5h5v5h-5zM8 1.5v4M8 10.5v4M1.5 8h4M10.5 8h4M6 1.5h4M6 14.5h4M1.5 6v4M14.5 6v4" },
  drawer: { label: "抽屉 / 滑动面板", path: "M2 2.5h12v11H2zM6 2.5v11M8 8h4M10 6l2 2-2 2" },
  pager: { label: "分页容器", path: "M4 2.5h8v9H4zM1.5 4v6M14.5 4v6M5 14h.01M8 14h.01M11 14h.01" },
  list: { label: "列表", path: "M2 3h1M6 3h8M2 8h1M6 8h8M2 13h1M6 13h8" },
  grid: { label: "网格", path: "M2 2h4.5v4.5H2zM9.5 2H14v4.5H9.5zM2 9.5h4.5V14H2zM9.5 9.5H14V14H9.5z" },
  scroll: { label: "滚动区域", path: "M10 2H2v12h8M5 5h3M5 8h3M5 11h3M13 2v12M11 4l2-2 2 2M11 12l2 2 2-2" },
  text: { label: "文字", path: "M3 4V2.5h10V4M8 2.5v11M5.5 13.5h5" },
  image: { label: "图片", path: "M2 2h12v12H2zM2 12l4-4 3 3 2-3 3 4M5 5h.01" },
  input: { label: "输入框", path: "M9 4H2v8h7M13 4h1v8h-1M4 8h3M9 2h4M11 2v12M9 14h4" },
  button: { label: "按钮", path: "M3.5 4h9a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM5 8h6" },
  checkbox: { label: "复选框", path: "M2.5 2.5h11v11h-11zM5 8l2 2 4-4" },
  radio: { label: "单选框", path: "M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0M10 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0" },
  switch: { label: "开关", path: "M5 4h6a4 4 0 0 1 0 8H5a4 4 0 0 1 0-8zM7 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0" },
  slider: { label: "滑块", path: "M1.5 8H6M10 8h4.5M6 5h4v6H6z" },
  progress: { label: "进度条 / 加载指示", path: "M1.5 5h13v6h-13zM4 7v2M6.5 7v2M9 7v2" },
  web: { label: "网页", path: "M2 2h12v12H2zM2 5h12M6 7l-2 2 2 2M10 7l2 2-2 2" },
  video: { label: "视频画面", path: "M2 2.5h12v11H2zM6.5 5l4 3-4 3z" },
  surface: { label: "独立渲染画面", path: "M2 2h12v10H2zM5 14h6M8 12v2M4 6l2-2M4 9l5-5M8 9l4-4" },
  stub: { label: "延迟加载占位", path: "M2.5 5v-2.5H5M11 2.5h2.5V5M13.5 11v2.5H11M5 13.5H2.5V11M5.5 8h5M8 5.5v5" },
  container: { label: "容器", path: "M1.5 4h5l1.5-2h6.5v11h-13zM1.5 6h13" },
  leaf: { label: "普通控件", path: "M2.5 2.5h11v11h-11zM5.5 5.5h5v5h-5z" },
};

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
  const resourceLabel = !node.attributes?.["debug-name"]?.trim() && !node.text?.trim() && !node.contentDesc?.trim() && Boolean(node.resourceId);
  const kind = treeNodeKind(node);
  const icon = TREE_ICONS[kind];
  const muted = !node.visibleToUser || !node.enabled;
  // ponytail: cap deep indentation so Android trees stay readable in a narrow inspector rail.
  const visualDepth = Math.min(depth, 7);
  const title = [label, icon.label, node.className, node.resourceId, node.contentDesc, `#${node.id} · 第 ${depth + 1} 层`, node.clickable && "可点击"].filter(Boolean).join("\n");
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
      aria-label={[label, icon.label, hasSecondaryLabel && shortClass, node.clickable && "可点击", !node.enabled && "不可用", !node.visibleToUser && "不可见"].filter(Boolean).join("，")}
      data-tree-kind={kind}
      className={`tree-row tree-kind-${kind} ${hasSecondaryLabel ? "has-secondary-label" : ""} ${muted ? "is-muted" : ""} ${selected ? "selected" : ""} ${active ? "active" : ""}`}
      style={{ paddingLeft: 8 + visualDepth * 12, "--tree-indent": `${visualDepth * 12}px` } as CSSProperties}
      title={title}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onSelect(node.id)}
      onDoubleClick={() => { if (hasChildren && !expanded) onToggle(node.id); }}
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
        onDoubleClick={(event) => event.stopPropagation()}
      >{hasChildren ? (expanded ? "▾" : "▸") : ""}</span>
      <svg className="tree-node-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <title>{icon.label} · {shortClass}</title>
        <path d={icon.path} />
      </svg>
      <span className="tree-row-content">
        <span className={`tree-primary ${hasSecondaryLabel ? "tree-label" : "tree-class"} ${resourceLabel ? "is-resource" : ""}`}>{label}</span>
        {hasSecondaryLabel && <span className="tree-class">{shortClass}</span>}
      </span>
      {node.clickable && <span className="tree-flag" title="可点击" aria-hidden="true" />}
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
          <button className="tree-clear tree-expand-all" type="button" aria-label="全部展开" title="全部展开" disabled={filterActive || rows.length === 0} onClick={() => onExpandedChange(allExpandedIds)}>展开</button>
          <button className="tree-clear tree-collapse-all" type="button" aria-label="全部折叠" title="全部折叠" disabled={filterActive || rows.length === 0} onClick={() => onExpandedChange(new Set())}>折叠</button>
          <button className="tree-clear tree-locate" type="button" aria-label="定位选中" title="定位选中" disabled={!selectedId || !index.has(selectedId)} onClick={() => { onClearFilter(); setLocalReveal((value) => value + 1); }}>定位</button>
        </div>
        <span className="tree-hint" title={`共 ${index.size} 个节点，当前 ${rows.length} 项。双击父节点展开；方向键浏览，Home/End 跳转。${virtual ? "按需渲染。" : ""}${filterActive ? "筛选期间保持展开。" : ""}`}>{rows.length === index.size ? rows.length : `${rows.length}/${index.size}`} 项</span>
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
