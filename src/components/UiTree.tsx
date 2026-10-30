import { workbenchCommands } from "../../shared/workbench-commands";
import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, SetStateAction } from "react";
import { createTreeMatcher, nodeDisplayLabel, nodeResourceName, nodeShortClass, treeNodeKind, treeSearchDetail, treeTextSegments, type TreeFilter } from "../../shared/tree-utils";
import { collapseTreeBranch, expandAncestors, indexTree, nearestVisibleId, scrollToTreeDepth, scrollToTreeRow, TREE_INDENT, TREE_ROW_CONTENT_WIDTH, TREE_ROW_HEIGHT, TREE_VIRTUAL_THRESHOLD, treeWindow, visibleTreeRows } from "../../shared/visible-tree";
import type { TreeRow } from "../../shared/visible-tree";
import type { InspectionSource, TreeDoubleClickAction, UiNode } from "../../shared/types";
import { nodePresentationStatus } from "../../shared/node-presentation-status";
import { NodeStatusBadge } from "./NodePresentationStatus";
import { treeHoverGuide } from "../../shared/node-hover";
import { useNodeHover } from "../features/inspection/NodeHoverContext";
import { treeExpansionForPreset, type TreeExpansionPreset } from "../../shared/tree-collapse";
import { TreeExpansionPresets } from "./TreeExpansionPresets";
import { NodeHistoryControls } from "./NodeHistoryControls";
import type { NodeHistoryControlsState, NodeHistoryView } from "../features/inspection/node-visit-history";
import "../styles/node-hover.css";

type UiTreeProps = {
  root: UiNode;
  filteredRoot: UiNode | null;
  filterActive: boolean;
  filterKey: string;
  filter?: TreeFilter;
  selectedId: string | null;
  expanded: ReadonlySet<string>;
  expansionDisabled?: boolean;
  hiddenNodeIds?: ReadonlySet<string>;
  inspectionSource?: InspectionSource;
  captureMode?: "fast" | "deep";
  imageCapturePending?: boolean;
  revealRequest?: number;
  restoreRequest?: number;
  focusKey?: string | null;
  doubleClickAction?: TreeDoubleClickAction;
  onDoubleClick?: (node: UiNode) => void;
  onContextMenu?: (node: UiNode) => void;
  onExpandedChange: (next: SetStateAction<ReadonlySet<string>>) => void;
  onSelect: (node: UiNode) => void;
  onClearFilter: () => void;
  history?: NodeHistoryControlsState;
  historyView?: NodeHistoryView;
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
  originalNode: UiNode;
  domId: string;
  selected: boolean;
  active: boolean;
  hovered: boolean;
  expanded: boolean;
  filterActive: boolean;
  query: string;
  searchMatch: boolean | undefined;
  hiddenByUser: boolean;
  inspectionSource?: InspectionSource;
  captureMode?: "fast" | "deep";
  imageCapturePending: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onDoubleClick: (id: string) => void;
  onContextMenu?: (node: UiNode) => void;
  onHover: (id: string | null) => void;
};

function HighlightedText({ text, query }: { text: string; query: string }) {
  return treeTextSegments(text, query).map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : part.text);
}

const UiTreeRow = memo(function UiTreeRow({ row, originalNode: node, domId, selected, active, hovered, expanded, filterActive, query, searchMatch, hiddenByUser, inspectionSource, captureMode, imageCapturePending, onSelect, onToggle, onDoubleClick, onContextMenu, onHover }: RowProps) {
  const presentationStatus = useMemo(() => nodePresentationStatus(node, {
    hiddenByUser: hiddenByUser ? "node" : undefined, inspectionSource, captureMode,
    waitingForImage: imageCapturePending && (!node.layerImageStatus || node.layerImageStatus === "unavailable"),
  }), [node, hiddenByUser, inspectionSource, captureMode, imageCapturePending]);
  const { depth } = row;
  const hasChildren = row.node.children.length > 0;
  const shortClass = nodeShortClass(node);
  const label = nodeDisplayLabel(node);
  const matchDetail = searchMatch ? treeSearchDetail(node, label, query) : null;
  const hasSecondaryLabel = label !== shortClass;
  const resourceLabel = !node.attributes?.["debug-name"]?.trim() && !node.text?.trim() && !node.contentDesc?.trim() && Boolean(nodeResourceName(node));
  const kind = treeNodeKind(node);
  const icon = TREE_ICONS[kind];
  const muted = !node.visibleToUser || !node.enabled || presentationStatus.code === "user-hidden";
  const title = [label, icon.label, node.className, node.resourceId, node.contentDesc, `#${node.id} · 第 ${depth + 1} 层`, node.clickable && "可点击", presentationStatus.badgeLabel && `${presentationStatus.label}：${presentationStatus.detail}`].filter(Boolean).join("\n");
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
      aria-label={[label, icon.label, hasSecondaryLabel && shortClass, node.clickable && "可点击", !node.enabled && "不可用", presentationStatus.badgeLabel].filter(Boolean).join("，")}
      data-tree-kind={kind}
      data-search-match={searchMatch}
      data-hovered={hovered || undefined}
      className={`tree-row tree-kind-${kind} ${hasSecondaryLabel ? "has-secondary-label" : ""} ${matchDetail ? "has-match-detail" : ""} ${searchMatch === false ? "is-search-context" : ""} ${muted ? "is-muted" : ""} ${selected ? "selected" : ""} ${active ? "active" : ""} ${hovered ? "is-hovered" : ""}`}
      style={{ paddingLeft: 8 + depth * TREE_INDENT, "--tree-indent": `${depth * TREE_INDENT}px` } as CSSProperties}
      title={title}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={() => onHover(node.id)}
      onClick={() => onSelect(node.id)}
      onDoubleClick={(event) => {
        if (event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) onDoubleClick(node.id);
      }}
      onContextMenu={onContextMenu ? (event) => { event.preventDefault(); onContextMenu(node); } : undefined}
    >
      <span
        aria-hidden="true"
        className={`tree-chevron ${hasChildren ? "has-children" : "leaf"} ${expanded ? "expanded" : ""}`}
        title={filterActive && hasChildren ? "筛选期间保持展开" : undefined}
        onClick={(event) => {
          if (!hasChildren || event.detail > 1) return;
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
        <span className={`tree-primary ${hasSecondaryLabel ? "tree-label" : "tree-class"} ${resourceLabel ? "is-resource" : ""}`}><HighlightedText text={label} query={query} /></span>
        {matchDetail ? <span className="tree-match-detail" title={`${matchDetail.field} · ${matchDetail.value}`}>
          {matchDetail.field} · <HighlightedText text={matchDetail.display} query={query} />
        </span> : hasSecondaryLabel && <span className="tree-class"><HighlightedText text={shortClass} query={query} /></span>}
      </span>
      <NodeStatusBadge status={presentationStatus} />
      {node.clickable && <span className="tree-flag" title="可点击" aria-hidden="true" />}
    </div>
  );
});

// The caller keys this component by inspection/history session, not by filter.
// Expansion belongs to the whole tree, never to rows that virtualization evicts.
export const UiTree = memo(function UiTree({ root, filteredRoot, filterActive, filterKey, filter, selectedId, expanded, expansionDisabled = false, hiddenNodeIds, inspectionSource, captureMode, imageCapturePending = false, revealRequest = 0, restoreRequest = 0, focusKey = null, doubleClickAction = "expand", onDoubleClick, onContextMenu, onExpandedChange, onSelect, onClearFilter, history, historyView }: UiTreeProps) {
  const { hover, publishHover, clearHover } = useNodeHover();
  const index = useMemo(() => indexTree(root), [root]);
  const [activeId, setActiveId] = useState<string | null>(selectedId);
  const [localReveal, setLocalReveal] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const lastScrollLeft = useRef(0);
  const [viewportHeight, setViewportHeight] = useState(450);
  const [viewportWidth, setViewportWidth] = useState(306);
  const previousViewportWidth = useRef(viewportWidth);
  const viewport = useRef<HTMLDivElement>(null);
  const pendingReveal = useRef<string | null>(null);
  const previousReveal = useRef<{ selectedId: string | null; revealRequest: number; restoreRequest: number; rootId: string; localReveal: number; filterKey: string; filterActive: boolean } | null>(null);
  const previousFocusKey = useRef(focusKey);
  const previousFocusReveal = useRef(revealRequest);
  const savedScrollTop = useRef<number | null>(null);
  const restoreScrollTop = useRef<number | null>(null);
  const savedScrollLeft = useRef(0);
  const restoreScrollLeft = useRef(0);
  const savedFilterScroll = useRef<{ top: number; left: number; focusKey: string | null; rootId: string } | null>(null);
  const handledHistoryView = useRef<NodeHistoryView["request"]>(null);
  const treeId = useId();
  const visibleExpansion = filterActive ? FILTER_EXPANDED : expanded;
  const rows = useMemo(() => visibleTreeRows(filteredRoot, visibleExpansion, filterActive), [filteredRoot, visibleExpansion, filterActive]);
  const contentWidth = useMemo(() => rows.reduce((depth, row) => Math.max(depth, row.depth), 0) * TREE_INDENT + TREE_ROW_CONTENT_WIDTH, [rows]);
  const positions = useMemo(() => new Map(rows.map((row, rowIndex) => [row.node.id, rowIndex])), [rows]);
  const query = filterActive ? filter?.query ?? "" : "";
  const interactiveOnly = filter?.interactiveOnly ?? false;
  const identifiedOnly = filter?.identifiedOnly ?? false;
  const hasFilterCriteria = filter !== undefined;
  const matchedIds = useMemo(() => {
    if (!filterActive || !hasFilterCriteria) return null;
    const matches = createTreeMatcher({ query, interactiveOnly, identifiedOnly });
    return new Set(rows.filter(row => matches(row.node)).map(row => row.node.id));
  }, [filterActive, hasFilterCriteria, rows, query, interactiveOnly, identifiedOnly]);
  const resolvedActive = nearestVisibleId(activeId, index, positions) ?? rows[0]?.node.id ?? null;
  const range = treeWindow(rows.length, scrollTop, viewportHeight);
  const virtual = rows.length >= TREE_VIRTUAL_THRESHOLD;
  const start = virtual ? range.start : 0;
  const end = virtual ? range.end : rows.length;
  const guide = treeHoverGuide(index, positions, hover?.nodeId ?? null, start, end);
  const activePosition = resolvedActive ? positions.get(resolvedActive) : undefined;
  const activeMounted = activePosition !== undefined && activePosition >= start && activePosition < end;
  const rowDomId = (id: string) => `${treeId}-${encodeURIComponent(id)}`;
  const allExpandedIds = useMemo(
    () => new Set([...index.values()].filter((row) => row.node.children.length > 0).map((row) => row.node.id)),
    [index],
  );

  const hoverRow = useCallback((id: string | null) => publishHover(id, "tree"), [publishHover]);

  useLayoutEffect(() => historyView?.register("tree", () => {
    const node = selectedId ? index.get(selectedId)?.node : null, element = viewport.current;
    return node && element ? { node, position: { top: element.scrollTop, left: element.scrollLeft, scope: focusKey, filtered: filterActive } } : null;
  }), [historyView?.register, selectedId, index, focusKey, filterActive]);

  useLayoutEffect(() => {
    if (hover?.source !== "tree") return;
    const position = positions.get(hover.nodeId);
    if (position === undefined || position < start || position >= end) clearHover("tree");
  }, [hover, positions, start, end, clearHover]);

  useLayoutEffect(() => {
    clearHover("tree");
    return () => clearHover("tree");
  }, [clearHover, filterKey, filterActive, focusKey]);

  useLayoutEffect(() => {
    const element = viewport.current!;
    const measure = () => { setViewportHeight(element.clientHeight); setViewportWidth(element.clientWidth); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Search paths never mutate the real expansion shared with the scene.
  // Clearing a filter keeps it intact; only an explicit locate may reopen the
  // selected path at that moment. Same-ID pixel updates do not replay reveals.
  useLayoutEffect(() => {
    const previous = previousReveal.current;
    previousReveal.current = { selectedId, revealRequest, restoreRequest, rootId: root.id, localReveal, filterKey, filterActive };
    const restoring = Boolean(previous && (previous.restoreRequest !== restoreRequest || previous.rootId !== root.id));
    const selectionChanged = !previous || previous.selectedId !== selectedId;
    const explicitReveal = !previous || previous.revealRequest !== revealRequest || previous.localReveal !== localReveal;
    const filterChanged = !previous || previous.filterKey !== filterKey || previous.filterActive !== filterActive;
    if (previous && !previous.filterActive && filterActive) {
      savedFilterScroll.current = { top: scrollTop, left: lastScrollLeft.current, focusKey: focusKey ?? null, rootId: root.id };
    } else if (previous?.filterActive && !filterActive) {
      const saved = savedFilterScroll.current;
      if (saved && !explicitReveal && !restoring && saved.rootId === root.id && saved.focusKey === (focusKey ?? null)) {
        restoreScrollTop.current = saved.top;
        restoreScrollLeft.current = saved.left;
      }
      savedFilterScroll.current = null;
    }
    if (!selectionChanged && !explicitReveal && !filterChanged && !restoring) return;
    let target = selectedId && index.has(selectedId) ? selectedId : root.id;
    if (filterActive) {
      if (!(selectionChanged || explicitReveal) || !positions.has(target)) {
        target = (matchedIds?.has(target) ? target : rows.find(row => matchedIds?.has(row.node.id))?.node.id)
          ?? (positions.has(target) ? target : rows[0]?.node.id) ?? target;
      }
    } else if ((previous?.filterActive || restoring) && !explicitReveal) {
      target = nearestVisibleId(target, index, positions) ?? rows[0]?.node.id ?? target;
    } else if (selectionChanged || explicitReveal) {
      onExpandedChange((current) => expandAncestors(index, current, target));
    }
    setActiveId(target);
    pendingReveal.current = target;
  }, [index, root.id, selectedId, revealRequest, restoreRequest, localReveal, filterKey, filterActive, rows, positions, matchedIds, onExpandedChange, focusKey, scrollTop]);

  useLayoutEffect(() => {
    const explicitlyRevealing = previousFocusReveal.current !== revealRequest;
    previousFocusReveal.current = revealRequest;
    if (previousFocusKey.current === focusKey) return;
    // The browser may already clamp the DOM scroll after the focused tree shrinks.
    if (!previousFocusKey.current && focusKey) {
      savedScrollTop.current = scrollTop;
      savedScrollLeft.current = lastScrollLeft.current;
    }
    if (previousFocusKey.current && !focusKey) {
      restoreScrollTop.current = explicitlyRevealing ? null : savedScrollTop.current;
      restoreScrollLeft.current = savedScrollLeft.current;
      savedScrollTop.current = null;
    }
    previousFocusKey.current = focusKey;
  }, [focusKey, revealRequest, scrollTop]);

  useLayoutEffect(() => {
    const request = historyView?.request;
    if (!request || handledHistoryView.current === request || request.node.id !== selectedId || index.get(request.node.id)?.node !== request.node) return;
    // Wait until the history navigation's required ancestors have mounted.
    if (!positions.has(request.node.id)) return;
    handledHistoryView.current = request;
    const position = request.positions.tree;
    if (request.restoring && position && !position.filtered && (position.scope ?? null) === focusKey) {
      restoreScrollTop.current = position.top; restoreScrollLeft.current = position.left;
    }
  }, [historyView?.request, selectedId, index, positions, focusKey]);

  useLayoutEffect(() => {
    const element = viewport.current!;
    let next = treeWindow(rows.length, element.scrollTop, element.clientHeight).top;
    const target = pendingReveal.current;
    const widthChanged = previousViewportWidth.current !== viewportWidth;
    previousViewportWidth.current = viewportWidth;
    if (restoreScrollTop.current !== null) {
      next = treeWindow(rows.length, restoreScrollTop.current, element.clientHeight).top;
      element.scrollLeft = restoreScrollLeft.current;
      restoreScrollTop.current = null;
      pendingReveal.current = null;
    } else if (target) {
      const position = positions.get(target);
      if (position !== undefined) {
        next = scrollToTreeRow(position, rows.length, next, element.clientHeight);
        element.scrollLeft = scrollToTreeDepth(rows[position].depth, element.scrollLeft, element.clientWidth);
        pendingReveal.current = null;
      } else if (filterActive || !index.has(target)) {
        next = 0;
        pendingReveal.current = null;
      }
    } else if (widthChanged && activeMounted && activePosition !== undefined) {
      element.scrollLeft = scrollToTreeDepth(rows[activePosition].depth, element.scrollLeft, element.clientWidth);
    }
    element.scrollTop = next;
    lastScrollLeft.current = element.scrollLeft;
    setScrollTop(next);
  }, [rows, positions, index, filterActive, filterKey, selectedId, revealRequest, restoreRequest, focusKey, localReveal, viewportHeight, viewportWidth, historyView?.request]);

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

  const double = useCallback((id: string) => {
    const node = index.get(id)?.node;
    if (!node) return;
    if (onDoubleClick) onDoubleClick(node);
    else if (node.children.length && (doubleClickAction === "toggle" || !expanded.has(id))) toggle(id);
  }, [index, onDoubleClick, doubleClickAction, expanded, toggle]);

  const applyExpansionPreset = useCallback((preset: TreeExpansionPreset) => {
    if (filterActive || expansionDisabled || rows.length === 0) return;
    onExpandedChange(current => treeExpansionForPreset(root, preset, current, selectedId));
    if (selectedId && index.has(selectedId)) {
      setActiveId(selectedId);
      pendingReveal.current = selectedId;
    }
  }, [filterActive, expansionDisabled, rows.length, onExpandedChange, root, selectedId, index]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if ((event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) && onContextMenu) {
      const node = resolvedActive && index.get(resolvedActive)?.node;
      if (node) { event.preventDefault(); onContextMenu(node); }
      return;
    }
    if (event.key === "Escape" && filterActive) {
      event.preventDefault(); event.stopPropagation(); onClearFilter(); return;
    }
    if (activePosition === undefined) return;
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
          <button className="tree-clear tree-expand-all" type="button" aria-label={workbenchCommands["expand-all"].label} title={workbenchCommands["expand-all"].label} disabled={filterActive || rows.length === 0} onClick={() => onExpandedChange(allExpandedIds)}>展开</button>
          <button className="tree-clear tree-collapse-all" type="button" aria-label={workbenchCommands["collapse-all"].label} title={workbenchCommands["collapse-all"].label} disabled={filterActive || rows.length === 0} onClick={() => onExpandedChange(new Set())}>折叠</button>
          <button className="tree-clear tree-locate" type="button" aria-label="定位选中" title="定位选中" disabled={!selectedId || !index.has(selectedId)} onClick={() => { onClearFilter(); setLocalReveal((value) => value + 1); }}>定位</button>
        </div>
        {history && <NodeHistoryControls history={history} />}
        <span className="tree-hint" role="status" title={`共 ${index.size} 个节点，当前 ${rows.length} 项。${matchedIds ? `${matchedIds.size} 个匹配，${rows.length - matchedIds.size} 个祖先路径。` : ""}双击${doubleClickAction === "focus-branch" ? "聚焦分支" : doubleClickAction === "toggle" ? "展开/收起" : "仅展开"}；方向键浏览，Home/End 跳转。${virtual ? "按需渲染。" : ""}${filterActive ? "筛选期间仅临时显示路径，Escape清除。" : ""}`}>{matchedIds ? `${matchedIds.size} 匹配` : `${rows.length === index.size ? rows.length : `${rows.length}/${index.size}`} 项`}</span>
      </div>
      <TreeExpansionPresets disabledReason={filterActive ? "清除筛选后可调整层级" : expansionDisabled ? "采集期间暂时无法调整层级" : rows.length === 0 ? "暂无可调整的层级" : null} onApply={applyExpansionPreset} />
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
        onFocus={() => {
          const element = viewport.current;
          if (!element || activePosition === undefined) return;
          element.scrollTop = scrollToTreeRow(activePosition, rows.length, element.scrollTop, element.clientHeight);
          element.scrollLeft = scrollToTreeDepth(rows[activePosition].depth, element.scrollLeft, element.clientWidth);
          lastScrollLeft.current = element.scrollLeft;
          setScrollTop(element.scrollTop);
        }}
        onScroll={(event) => { lastScrollLeft.current = event.currentTarget.scrollLeft; setScrollTop(event.currentTarget.scrollTop); }}
        onMouseLeave={() => clearHover("tree")}
        onMouseMove={(event) => {
          // Rows may remain under the pointer while a filter or scroll changes
          // their presentation. Republish only the current actual row.
          const target = (event.target as HTMLElement).closest<HTMLElement>(".tree-row");
          if (target && event.currentTarget.contains(target)) hoverRow(target.dataset.treeId ?? null);
          else clearHover("tree");
        }}
      >
        {rows.length > 0 ? (
          <div className="tree-rows" role="none" style={{ height: range.totalHeight, minWidth: contentWidth }}>
            <div role="none" style={{ transform: `translateY(${start * TREE_ROW_HEIGHT}px)` }}>
              {rows.slice(start, end).map((row) => (
                <UiTreeRow key={row.node.id} row={row} originalNode={index.get(row.node.id)?.node ?? row.node} domId={rowDomId(row.node.id)} selected={row.node.id === selectedId} active={row.node.id === resolvedActive} hovered={row.node.id === hover?.nodeId} expanded={filterActive || expanded.has(row.node.id)} filterActive={filterActive} query={query} searchMatch={matchedIds?.has(row.node.id)} hiddenByUser={Boolean(hiddenNodeIds?.has(row.node.id))} inspectionSource={inspectionSource} captureMode={captureMode} imageCapturePending={imageCapturePending} onSelect={select} onToggle={toggle} onDoubleClick={double} onContextMenu={onContextMenu} onHover={hoverRow} />
              ))}
            </div>
            {guide && <svg className="tree-hover-guide" aria-hidden="true" focusable="false"
              data-hover-node-id={guide.nodeId} data-hover-parent-id={guide.parentId}
              width={guide.childX + 4} height={guide.height} style={{ top: guide.top }}>
              <path d={guide.path} />
              {guide.parentVisible && <circle cx={guide.parentX} cy={guide.parentY + 8} r="1.8" />}
              <circle cx={guide.childX} cy={guide.childY} r="1.8" />
            </svg>}
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
