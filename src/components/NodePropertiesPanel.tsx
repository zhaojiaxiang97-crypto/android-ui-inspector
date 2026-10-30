import { AppIcon } from "./AppIcon";
import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { InspectionSource, PixelSize, QmlGroupImage, UiNode, ViewStyleResult } from "../../shared/types";
import { nodePresentationStatus } from "../../shared/node-presentation-status";
import { NodePresentationStatus } from "./NodePresentationStatus";
import { nodeMetrics } from "../../shared/node-metrics";
import { nodeDisplayLabel, nodeResourceName, nodeShortClass } from "../../shared/tree-utils";
import { debugFieldSearchValues, type DebugGroup } from "../../shared/debug-metadata";
import { parseLayoutRules, layoutRuleLabels, layoutRuleValue } from "../../shared/layout-relations";
import { LayoutRuleProperties } from "./LayoutRuleProperties";
import { DebugMetadataFields } from "./DebugMetadataFields";
import { LongTextValue } from "./LongTextValue";
import { colorAlias, colorHex, colorRgba, DEFAULT_COLOR_ALIASES, parseInspectorColor,
  type ColorAliasPreference, type InspectorColorEncoding } from "../../shared/inspector-colors";
import { ColorProperty } from "./ColorProperty";
import { FloatingInspectorResize } from "./FloatingInspectorResize";
import { useFloatingInspectorLayout } from "../features/inspection/useFloatingInspectorLayout";
import type { WorkspaceLayout } from "../../shared/workspace-layout";
import { DEFAULT_COLOR_FORMAT, inspectorColorDisplay, type ColorDisplayFormat } from "../../shared/color-display";
import { NodeImageActions } from "./NodeImageActions";
import type { NodeImageActionController } from "../features/layers/useNodeImageActionController";
import { DEFAULT_INSPECTOR_GROUPS, INSPECTOR_GROUPS, inspectorGroupVisible,
  inspectorDisclosureOpen, withInspectorDisclosure, type InspectorDisclosureId, type InspectorGroupId, type InspectorGroupPreference } from "../../shared/inspector-groups";
import { INSPECTOR_SEARCH_HIGHLIGHT_MS, searchInspectorProperties } from "../../shared/inspector-search";
import { indexInspectorProperties, type IndexedInspectorProperty } from "../features/inspection/inspector-search-index";
import { InspectorSearchResults } from "./InspectorSearchResults";
import { NodePathNavigator } from "./NodePathNavigator";
import type { NodeHistoryView } from "../features/inspection/node-visit-history";
import { PinnedNodeReference } from "./PinnedNodeReference";
import { InspectorGroupControls } from "./InspectorGroupControls";
import { nodeReferenceStatus, pinNodeReference, type PinnedNodeReference as Reference, type ReferenceSnapshot } from "../features/inspection/node-reference";
import "../styles/inspector-compact.css";

export type NodePropertiesRevealRequest = { root: UiNode; nodeId: string };

type Props = {
  root: UiNode;
  node: UiNode;
  hiddenByUser?: boolean;
  inspectionSource?: InspectionSource;
  captureMode?: "fast" | "deep";
  imageCapturePending?: boolean;
  imageSessionKey?: string | number;
  imageController?: NodeImageActionController;
  groupImage?: QmlGroupImage | null;
  screenshotSize: PixelSize | null;
  toolbarHost: HTMLElement | null;
  onCopy: () => void;
  onCopyValue?: (label: string, value: string) => void;
  copyStatus: string | null;
  onRefresh?: () => void;
  onRefreshBranch?: () => void;
  onRefreshList?: () => void;
  onReadStyle?: () => Promise<ViewStyleResult>;
  refreshBusy?: boolean;
  refreshStatus?: string | null;
  revealRequest?: NodePropertiesRevealRequest | null;
  docked?: boolean;
  colorAliases?: ColorAliasPreference;
  inspectorGroups?: InspectorGroupPreference;
  onSaveInspectorGroups?: (value: InspectorGroupPreference) => boolean;
  onOpenGroupPreferences?: () => void;
  onNavigateNode?: (node: UiNode, sourceRoot: UiNode) => boolean;
  navigationDisabled?: boolean;
  historyView?: NodeHistoryView;
  colorFormat?: ColorDisplayFormat;
  onColorFormatChange?: (value: ColorDisplayFormat) => boolean;
  colorFormatSaveError?: boolean;
  referenceSnapshot?: ReferenceSnapshot;
  inspectorLayout?: WorkspaceLayout["inspector"];
  onInspectorLayoutChange?: (value: WorkspaceLayout["inspector"]) => boolean;
  children: ReactNode;
};

const DisclosurePreferenceContext = createContext<{
  preference: InspectorGroupPreference;
  onChange?: (id: InspectorDisclosureId, open: boolean) => void;
}>({ preference: DEFAULT_INSPECTOR_GROUPS });

// Search reveals matches temporarily; the user's normal disclosure state stays intact.
const SearchRevealContext = createContext<{ query: string; scope: object | null; request: { id: string; revision: number } | null }>({ query: "", scope: null, request: null });
function InspectorGroup({ className, disclosureId, defaultOpen = false, hidden, searchKey = null, children }: {
  className: string; disclosureId?: InspectorDisclosureId; defaultOpen?: boolean; hidden?: boolean; searchKey?: string | null; children: ReactNode;
}) {
  const disclosure = useContext(DisclosurePreferenceContext);
  const [localExpanded, setExpanded] = useState(disclosureId ? inspectorDisclosureOpen(disclosure.preference, disclosureId) : defaultOpen);
  const expanded = disclosureId && disclosure.onChange ? inspectorDisclosureOpen(disclosure.preference, disclosureId) : localExpanded;
  const [foldedSearch, setFoldedSearch] = useState<string | null>(null);
  const [locatedSearch, setLocatedSearch] = useState<string | null>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const reveal = useContext(SearchRevealContext);
  useEffect(() => { if (!searchKey) setFoldedSearch(null); }, [searchKey]);
  useLayoutEffect(() => { setLocatedSearch(null); setFoldedSearch(null); }, [reveal.query, reveal.scope]);
  useLayoutEffect(() => {
    if (reveal.query && reveal.request && detailsRef.current?.querySelector(`[data-inspector-property="${reveal.request.id}"]`)) {
      setFoldedSearch(null);
      setLocatedSearch(reveal.query);
    }
  }, [reveal.query, reveal.request]);
  const open = reveal.query && foldedSearch === reveal.query ? false
    : reveal.query && locatedSearch === reveal.query ? true : searchKey ? foldedSearch !== searchKey : expanded;
  return <details ref={detailsRef} className={className} open={open} hidden={hidden} onClick={event => {
    if (event.target instanceof Element && event.target.closest("[data-inspector-group-control]")) return;
    const summary = event.target instanceof Element ? event.target.closest("summary") : null;
    if (summary?.parentElement !== event.currentTarget) return;
    event.preventDefault();
    if (reveal.query || searchKey) {
      const key = reveal.query || searchKey;
      setFoldedSearch(open ? key : null);
      setLocatedSearch(open ? null : key);
    }
    else {
      setExpanded(!open);
      if (disclosureId) disclosure.onChange?.(disclosureId, !open);
    }
  }}>{children}</details>;
}

function CopyIcon() {
  return <AppIcon name="copy" size={16} />;
}

function valueOrDash(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function px(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : `${Math.round(value * 100) / 100}px`;
}

function layoutDimension(value: string | undefined) {
  if (!value?.trim()) return "—";
  const number = Number(value);
  return number === -1 ? "match_parent" : number === -2 ? "wrap_content" : Number.isFinite(number) && number >= 0 ? px(number) : "—";
}

function gravityLabel(raw: string | undefined) {
  if (!raw?.trim()) return "—";
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < -1) return "—";
  if (value === -1) return "未指定";
  const horizontal: Record<number, string> = { 0: "", 1: "水平居中", 3: "左", 5: "右", 7: "水平填充", 8388611: "起始侧", 8388613: "结束侧" };
  const vertical: Record<number, string> = { 0: "", 16: "垂直居中", 48: "上", 80: "下", 112: "垂直填充" };
  const x = value & 0x800007, y = value & 0x70;
  const code = `0x${value.toString(16)}`;
  if (horizontal[x] === undefined || vertical[y] === undefined || (value & ~(0x800007 | 0x70)) !== 0) return `原始值 ${code}`;
  return `${[horizontal[x], vertical[y]].filter(Boolean).join(" · ") || "无"} (${code})`;
}

// Let a tall inspector shrink its scroll area while moving; keep its header reachable.
function placeInspector(panel: HTMLElement, x: number, y: number) {
  const workspace = panel.parentElement;
  if (!workspace) return;
  const viewportHeight = Number.parseFloat(panel.style.getPropertyValue("--inspector-viewport-height")) || workspace.clientHeight;
  const minTop = Number.parseFloat(panel.style.getPropertyValue("--inspector-min-top")) || 12;
  panel.style.left = `${Math.max(12, Math.min(x, workspace.clientWidth - panel.offsetWidth - 12))}px`;
  panel.style.right = "auto";
  panel.style.setProperty("--inspector-top", `${Math.max(minTop, Math.min(y, viewportHeight - Math.min(panel.offsetHeight, 160) - 16))}px`);
}

export function NodePropertiesPanel({ root, node, hiddenByUser = false, inspectionSource, captureMode, imageCapturePending = false, imageSessionKey, imageController, groupImage, screenshotSize, toolbarHost, onCopy, onCopyValue, copyStatus, onRefresh, onRefreshBranch, onRefreshList, onReadStyle, refreshBusy, refreshStatus, revealRequest, docked = false, colorAliases = DEFAULT_COLOR_ALIASES, inspectorGroups = DEFAULT_INSPECTOR_GROUPS, onSaveInspectorGroups, onOpenGroupPreferences, onNavigateNode, navigationDisabled, historyView, colorFormat = DEFAULT_COLOR_FORMAT, onColorFormatChange, colorFormatSaveError = false, referenceSnapshot, inspectorLayout, onInspectorLayoutChange, children }: Props) {
  const [visible, setVisible] = useState(true);
  const [reference, setReference] = useState<Reference | null>(null);
  const referencePinRef = useRef<HTMLButtonElement>(null);
  const pinnedReference = reference?.session === imageSessionKey ? reference : null;
  const referenceStatus = useMemo(() => pinnedReference ? nodeReferenceStatus(pinnedReference, root) : "current", [pinnedReference, root]);
  useLayoutEffect(() => { setReference(null); }, [imageSessionKey]);
  const closeReference = () => { setReference(null); referencePinRef.current?.focus({ preventScroll: true }); };
  const [disclosureSaveError, setDisclosureSaveError] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [floating, setFloating] = useState(false);
  const isDocked = docked && !floating;
  const [search, setSearch] = useState("");
  const [searchProperties, setSearchProperties] = useState<IndexedInspectorProperty[]>([]);
  const [searchReveal, setSearchReveal] = useState<{ scope: object; id: string; revision: number; property: IndexedInspectorProperty } | null>(null);
  const revealRevision = useRef(0);
  const highlightedProperty = useRef<HTMLElement | null>(null);
  const [style, setStyle] = useState<{ root: UiNode; value: ViewStyleResult } | null>(null);
  const [styleError, setStyleError] = useState<string | null>(null);
  const [styleBusy, setStyleBusy] = useState(false);
  const styleRequest = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  const { persistInspectorLayout, layoutSaveError } = useFloatingInspectorLayout({ panelRef, floating, visible, collapsed,
    layout: inspectorLayout, onSave: onInspectorLayoutChange, onFloatingChange: setFloating });
  const toggleRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const handledReveal = useRef<NodePropertiesRevealRequest | null>(null);
  const panelId = useId();
  useLayoutEffect(() => historyView?.register("inspector", () => {
    const body = panelRef.current?.querySelector<HTMLElement>(".inspector-body");
    return body && visible && !collapsed ? { node, position: { top: body.scrollTop, left: body.scrollLeft, search } } : null;
  }), [historyView?.register, node, visible, collapsed, search]);
  useLayoutEffect(() => {
    const request = historyView?.request;
    if (!request || request.root !== root || request.node !== node
      || revealRequest && handledReveal.current !== revealRequest && revealRequest.root === root && revealRequest.nodeId === node.id) return;
    const body = panelRef.current?.querySelector<HTMLElement>(".inspector-body");
    if (!body) return;
    if (!request.restoring) { body.scrollTo({ top: 0, left: 0, behavior: "instant" }); return; }
    const position = request.positions.inspector;
    setVisible(true); setCollapsed(false); setSearch(position?.search ?? "");
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => body.scrollTo({ top: position?.top ?? 0, left: position?.left ?? 0, behavior: "instant" }));
    });
    return () => cancelAnimationFrame(frame);
  }, [historyView?.request, root, node, revealRequest]);
  useEffect(() => {
    if (!revealRequest || handledReveal.current === revealRequest || revealRequest.root !== root || revealRequest.nodeId !== node.id) return;
    handledReveal.current = revealRequest;
    setVisible(true);
    setCollapsed(false);
    setSearch("");
    // Report reveals temporarily dock the inspector without changing the saved layout.
    setFloating(false);
    const panel = panelRef.current;
    panel?.style.removeProperty("left");
    panel?.style.removeProperty("right");
    panel?.style.removeProperty("--inspector-top");
    // The report dialog closes in its effect; focus only after it releases the workbench.
    const frame = requestAnimationFrame(() => {
      const body = panel?.querySelector<HTMLElement>(".inspector-body");
      if (body) body.scrollTop = 0;
      panel?.querySelector<HTMLButtonElement>(".inspector-drag-handle")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [revealRequest, root, node.id]);
  useEffect(() => {
    styleRequest.current++;
    setStyle(null);
    setStyleError(null);
    setStyleBusy(false);
    return () => { styleRequest.current++; };
  }, [node.id, root]);

  async function readStyle() {
    if (!onReadStyle || styleBusy) return;
    const request = ++styleRequest.current;
    setStyleBusy(true);
    setStyle(null);
    setStyleError(null);
    try {
      const result = await onReadStyle();
      if (styleRequest.current === request) setStyle({ root, value: result });
    } catch (error) {
      if (styleRequest.current === request) setStyleError(error instanceof Error ? error.message : "读取样式失败。");
    } finally {
      if (styleRequest.current === request) setStyleBusy(false);
    }
  }
  useEffect(() => {
    const panel = panelRef.current;
    const workspace = panel?.parentElement;
    if (!visible || !panel || !workspace) return;
    let canvas: HTMLElement | null = null;
    let frame = 0;
    const updateBounds = () => {
      frame = 0;
      // Snapshot handoff can replace the keyed preview without changing the root object.
      // Observe the current canvas, not the detached one whose height becomes zero.
      const currentCanvas = workspace.querySelector<HTMLElement>(".screenshot-frame");
      if (currentCanvas !== canvas) {
        if (canvas) observer.unobserve(canvas);
        canvas = currentCanvas;
        if (canvas) observer.observe(canvas);
      }
      const height = Math.min(workspace.clientHeight, canvas ? canvas.offsetTop + canvas.offsetHeight : workspace.clientHeight);
      if (height <= 0) return;
      const viewportHeight = `${height}px`, minTop = `${(canvas?.offsetTop ?? 0) + 12}px`;
      if (panel.style.getPropertyValue("--inspector-viewport-height") !== viewportHeight)
        panel.style.setProperty("--inspector-viewport-height", viewportHeight);
      if (panel.style.getPropertyValue("--inspector-min-top") !== minTop)
        panel.style.setProperty("--inspector-min-top", minTop);
      if (panel.style.left) placeInspector(panel, panel.offsetLeft, panel.offsetTop);
    };
    const observer = new ResizeObserver(() => {
      // Apply layout changes outside the observer delivery to avoid resize feedback loops.
      if (!frame) frame = requestAnimationFrame(updateBounds);
    });
    observer.observe(panel);
    observer.observe(workspace);
    frame = requestAnimationFrame(updateBounds);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [visible, root]);

  function closePanel() {
    setVisible(false);
    toggleRef.current?.focus();
  }

  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    panelRef.current?.classList.remove("is-dragging");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    persistInspectorLayout();
  }

  const metrics = useMemo(() => nodeMetrics(root, node, screenshotSize), [node, root, screenshotSize]);
  const referenceDisabledReason = navigationDisabled || refreshBusy || imageCapturePending ? "正在更新快照，完成后可固定参考" : styleBusy ? "正在读取样式，完成后可固定参考" : null;
  const shownStyle = style?.root === root && style.value.ref === node.attributes?.["view-ref"] ? style.value : null;
  const displayName = nodeDisplayLabel(node);
  const nameSource = node.attributes?.["debug-name"]?.trim() ? "Debug App 显式名称"
    : node.text?.trim() ? "控件文本" : node.contentDesc?.trim() ? "内容描述"
    : nodeResourceName(node) ? "资源 ID" : "真实类名";
  const classHierarchy = node.attributes?.["sdk-class-hierarchy"]?.split(" → ");
  const parent = metrics.parent;
  const parentName = parent ? nodeDisplayLabel(parent) : node.id === root.id ? "无（根节点）" : "未找到";
  const rect = metrics.rect;
  const parentOffset = metrics.parentOffset;
  const padding = [["top", "上"], ["right", "右"], ["bottom", "下"], ["left", "左"]].map(([side, label]) => {
    const raw = node.attributes?.[`padding-${side}`];
    return { side, label, value: raw?.trim() && Number.isFinite(Number(raw)) ? Number(raw) : null };
  });
  const borderWidth = node.attributes?.["border-status"] === "已读取" && node.attributes?.["border-width"]?.trim()
    ? Number(node.attributes["border-width"]) : null;
  const margins = ["Top", "Right", "Bottom", "Left"].map(side => node.attributes?.[`sdk-margin${side}`]);
  const measuredMargins = margins.map(value => value?.trim() && Number.isFinite(Number(value)) ? Number(value) : null);
  const marginLabel = measuredMargins.some(value => value !== null) ? measuredMargins.map(px).join(" / ") : "—";
  const layoutRules = parseLayoutRules(node.attributes?.["sdk-layout-rules"]);
  const hasSdkLayoutRule = node.attributes?.["sdk-layout-gravity"] !== undefined || node.attributes?.["sdk-layout-weight"] !== undefined || Boolean(layoutRules?.rules.length);
  const sdkInteractions = [
    ["可长按", "sdk-longClickable"], ["可上下文点击", "sdk-contextClickable"],
    ["点击监听器", "sdk-hasOnClickListeners"], ["按下中", "sdk-pressed"], ["已激活", "sdk-activated"],
  ] as const;
  const hasSdkInteraction = sdkInteractions.some(([, key]) => node.attributes?.[key] !== undefined);
  const flags = [
    node.clickable && "clickable",
    node.enabled && "enabled",
    node.focusable && "focusable",
    node.focused && "focused",
    node.scrollable && "scrollable",
    node.selected && "selected",
    !node.visibleToUser && "hidden",
  ].filter(Boolean).join(" · ") || "none";
  const sourceValue = node.attributes?.["inspection-source"];
  const source = node.attributes?.["tree-source"] === "debug-sdk" ? "SDK + View Debug"
    : sourceValue === "debug-qml" ? "QML Debug" : sourceValue === "debug-view" ? "View Debug"
    : sourceValue === "accessibility-helper" ? "无障碍 Helper" : sourceValue === "uiautomator" ? "UIAutomator" : sourceValue || "来源未标注";
  const semantics = [["提示", "hint"], ["错误信息", "error"], ["状态描述", "state-description"]]
    .filter(([, key]) => Boolean(node.attributes?.[key])).map(([label, key]) => [label, key, node.attributes?.[key] ?? ""]);
  const semanticSearchValues = semantics.flat();
  const presentationStatus = useMemo(() => nodePresentationStatus(node, {
    hiddenByUser: hiddenByUser ? "node" : undefined, inspectionSource, captureMode,
    waitingForImage: imageCapturePending && (!node.layerImageStatus || node.layerImageStatus === "unavailable"),
  }), [node, hiddenByUser, inspectionSource, captureMode, imageCapturePending]);
  const imageStatus = presentationStatus.ownImage.detail;
  const imageLabel = presentationStatus.ownImage.label;
  const query = search.trim().toLocaleLowerCase();
  const searchScope = useMemo(() => ({}), [root, node, imageSessionKey, query, shownStyle, colorAliases, colorFormat, visible, collapsed, presentationStatus]);
  const businessDisclosureScope = useMemo(() => ({}), [root, node, imageSessionKey]);
  const activeSearch = useRef({ scope: searchScope, active: visible && !collapsed });
  activeSearch.current = { scope: searchScope, active: visible && !collapsed };
  const [searchPage, setSearchPage] = useState<{ scope: object; index: number } | null>(null);
  const searchPageIndex = searchPage?.scope === searchScope ? searchPage.index : 0;
  const searchResults = useMemo(() => searchInspectorProperties(searchProperties, query, searchPageIndex), [searchProperties, query, searchPageIndex]);
  useLayoutEffect(() => {
    if (panelRef.current) setSearchProperties(indexInspectorProperties(panelRef.current));
  }, [root, node, shownStyle, colorAliases, colorFormat, children, presentationStatus]);
  useLayoutEffect(() => {
    const body = panelRef.current?.querySelector<HTMLElement>(".inspector-body");
    let frame = 0, timer: ReturnType<typeof setTimeout> | null = null;
    const clear = () => {
      cancelAnimationFrame(frame);
      if (timer !== null) clearTimeout(timer);
      if (highlightedProperty.current) {
        highlightedProperty.current.classList.remove("inspector-property-highlight");
        highlightedProperty.current = null;
        // Stop an in-flight smooth scroll when its search/node/panel becomes obsolete.
        body?.scrollTo({ top: body.scrollTop, behavior: "instant" });
      }
    };
    if (searchReveal && searchReveal.scope === searchScope && visible && !collapsed && body) {
      frame = requestAnimationFrame(() => {
        const target = searchReveal.property.element, panel = panelRef.current;
        if (activeSearch.current.scope !== searchReveal.scope || !activeSearch.current.active || !target.isConnected
          || !panel?.contains(target) || body.hidden || panel.hidden) return;
        const top = body.scrollTop + target.getBoundingClientRect().top - body.getBoundingClientRect().top - 24;
        body.scrollTo({ top: Math.max(0, top), behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
        target.classList.add("inspector-property-highlight");
        highlightedProperty.current = target;
        timer = setTimeout(() => {
          target.classList.remove("inspector-property-highlight");
          if (highlightedProperty.current === target) highlightedProperty.current = null;
        }, INSPECTOR_SEARCH_HIGHLIGHT_MS);
      });
    }
    return clear;
  }, [searchReveal, searchScope, visible, collapsed]);
  const locateProperty = (property: IndexedInspectorProperty, scope: object) => {
    if (scope !== activeSearch.current.scope || !activeSearch.current.active || !panelRef.current?.contains(property.element)) return;
    setSearchReveal({ scope, id: property.id, revision: ++revealRevision.current, property });
  };
  const searchRevealContext = useMemo(() => ({ query, scope: searchScope, request: searchReveal?.scope === searchScope && visible && !collapsed
    ? { id: searchReveal.id, revision: searchReveal.revision } : null }), [query, searchReveal, searchScope, visible, collapsed]);
  const colorTerms = (raw: string | null | undefined, encoding: InspectorColorEncoding) => {
    const color = parseInspectorColor(raw, encoding);
    return color ? [raw, colorHex(color), colorRgba(color), colorAlias(color, colorAliases)] : [raw];
  };
  const hasQmlColors = node.attributes?.["inspection-source"] === "debug-qml"
    && (node.attributes["background-color"] !== undefined || node.attributes["border-color"] !== undefined);
  const qmlColorTerms = hasQmlColors ? [node.attributes?.["background-color"], node.attributes?.["border-color"]]
    .flatMap(raw => colorTerms(raw, "qml-rgba")) : [];
  const liveColorTerms = [shownStyle?.backgroundColor, shownStyle?.textColor].flatMap(raw => colorTerms(raw, "android-argb"));
  const matches = (...values: unknown[]) => values.some(value => String(value ?? "").toLocaleLowerCase().includes(query));
  const reveal = (...values: unknown[]) => query && matches(...values) ? query : null;
  const debugMetadata = node.debugMetadata;
  const businessTerms = ["业务信息 business Debug SDK 显式登记 只读", debugMetadata?.status === "omitted-budget" ? "超过本次采集额度 未保存" : ""];
  const groupValues = (group: DebugGroup) => [group.key, group.label, ...group.fields.flatMap(field => debugFieldSearchValues(field, group.key))];
  const businessMatchAll = matches(...businessTerms);
  const copyField = (label: string, value: string | null | undefined) => value && onCopyValue
    ? <button className="inspector-field-copy" type="button" aria-label={`复制${label}`} title={`复制完整${label}`} onClick={() => onCopyValue(label, value)}><CopyIcon /></button> : null;
  const textValue = (label: string, value: string | null | undefined) => <LongTextValue label={label} value={valueOrDash(value)} onCopyValue={value ? onCopyValue : undefined} />;
  const ruleSearchValues = [gravityLabel(node.attributes?.["sdk-layout-gravity"]), ...(layoutRules?.rules.flatMap(([name, value]) => [layoutRuleLabels[name] ?? name, layoutRuleValue(name, value)]) ?? [])];
  const geometrySearchValues = [node.bounds?.raw, JSON.stringify(rect), node.attributes?.z, node.attributes?.["sdk-layout-params-class"], layoutDimension(node.attributes?.["sdk-layout-width"]), layoutDimension(node.attributes?.["sdk-layout-height"]), screenshotSize && `${screenshotSize.width} × ${screenshotSize.height}px`];
  const matching = {
    type: matches("类型 class 名称 来源 继承 父类 资源 ID resource-id 文本 text content-desc 描述 package 包名", ...semanticSearchValues, source, displayName, nameSource, classHierarchy?.join(" "), node.className, node.resourceId, node.package, node.text, node.contentDesc),
    business: Boolean(debugMetadata && (businessMatchAll || debugMetadata.groups.some(group => matches(...groupValues(group))))),
    relation: matches("关系 relation 父容器 parent 子节点 children 层级 depth index 序号", parentName, parent?.className, parent?.id, metrics.childCount, metrics.depth, node.index),
    layout: matches("布局 layout 位置 尺寸 geometry bounds 屏幕 px X Y W H width height 右 下 中心 面积 Z 父级内偏移 截图 padding 内边距 margin 外边距 border 边框 LayoutParams gravity weight 重力 权重 constraint 约束 对齐 父容器 偏置 宽高比", ...geometrySearchValues, ...ruleSearchValues, JSON.stringify(padding), marginLabel, node.attributes?.["sdk-layout-gravity"], node.attributes?.["sdk-layout-weight"], node.attributes?.["sdk-layout-rules"], borderWidth),
    interaction: hasSdkInteraction && matches("交互 点击 长按 上下文 点击监听器 按下 激活 SDK View", ...sdkInteractions.map(([, key]) => node.attributes?.[key])),
    image: matches("画面 image 自身图 分支 原生整组图 本地重建 样式 style 文本色 字号 设备可见 visible 可点击 clickable 背景色 background-color 边框色 border-color 颜色 别名 Hex RGBA ARGB 透明度 圆角 corner-radii", imageStatus, imageLabel, presentationStatus.label, presentationStatus.detail, node.visibleToUser ? "是" : "否", node.clickable ? "是" : "否", shownStyle?.backgroundType, ...liveColorTerms, ...qmlColorTerms, ...["image-source", "image-capture-error", "background-color", "border-color", "corner-radii"].map(key => node.attributes?.[key])),
    raw: matches("原始属性 调试 定位 flags", node.id, flags, JSON.stringify(node.attributes)),
  };
  const groupMatches = (id: InspectorGroupId) => matching[id] || searchResults.groups.has(id);
  const groupVisible = (id: InspectorGroupId) => inspectorGroupVisible(inspectorGroups, id, Boolean(query), groupMatches(id));
  const disclosurePreference = {
    preference: inspectorGroups,
    onChange: onSaveInspectorGroups ? (id: InspectorDisclosureId, open: boolean) => {
      setDisclosureSaveError(!onSaveInspectorGroups(withInspectorDisclosure(inspectorGroups, id, open)));
    } : undefined,
  };
  const saveGroupPreference = onSaveInspectorGroups ? (value: InspectorGroupPreference) => {
    const saved = onSaveInspectorGroups(value); setDisclosureSaveError(!saved); return saved;
  } : undefined;
  const groupControls = (group?: InspectorGroupId) => <InspectorGroupControls preference={inspectorGroups} onSave={saveGroupPreference}
    onOpenPreferences={onOpenGroupPreferences} group={group} scope={businessDisclosureScope}
    disabled={!visible || collapsed || Boolean(navigationDisabled || refreshBusy)} searching={Boolean(query)}
    colorFormat={colorFormat} onColorFormatChange={!group ? onColorFormatChange : undefined} colorFormatSaveError={colorFormatSaveError} />;
  const summaryColors = [
    ...(shownStyle ? [
      { label: "背景源色", raw: shownStyle.backgroundColor, encoding: "android-argb" as const },
      { label: "当前文字色", raw: shownStyle.textColor, encoding: "android-argb" as const },
    ] : hasQmlColors ? [
      { label: "背景源色", raw: node.attributes?.["background-color"], encoding: "qml-rgba" as const },
      { label: "边框源色", raw: node.attributes?.["border-color"], encoding: "qml-rgba" as const },
    ] : []),
  ].flatMap(entry => {
    const color = parseInspectorColor(entry.raw, entry.encoding);
    return color ? [{ ...entry, color, display: inspectorColorDisplay(entry.raw, entry.encoding, colorFormat, colorAliases) }] : [];
  });
  // Some sources do not supply business data or SDK interaction flags.
  const hasVisibleGroup = INSPECTOR_GROUPS.some(({ id }) =>
    (id !== "business" || Boolean(debugMetadata)) && (id !== "interaction" || hasSdkInteraction) && groupVisible(id));

  return (
    <>
      {toolbarHost && createPortal(
        <button ref={toggleRef} className="inspector-toggle" type="button" aria-label="显示或隐藏属性面板" title="属性面板" aria-expanded={visible} aria-controls={panelId}
          onClick={() => { setVisible(!visible); setCollapsed(false); }}>
          <AppIcon name="sidebar" size={18} /><span>属性面板</span>
        </button>, toolbarHost)}
      <aside id={panelId} ref={panelRef} className={`floating-inspector inspector-compact ${isDocked ? "is-docked" : ""} ${collapsed ? "is-collapsed" : ""}`} hidden={!visible} data-node-id={node.id} aria-label="节点属性"
        onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) closePanel(); }}>
        <div className="inspector-tab">
          <button className="inspector-drag-handle" type="button" aria-label={isDocked ? "属性面板" : "移动属性面板"} title={isDocked ? "属性栏已停靠右侧" : "拖动移动 · 方向键微调 · Home 复位"}
            onPointerDown={(event) => {
              if (isDocked || event.button !== 0 || !panelRef.current) return;
              const panel = panelRef.current;
              dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: panel.offsetLeft, top: panel.offsetTop };
              event.currentTarget.setPointerCapture(event.pointerId);
              panel.classList.add("is-dragging");
              event.currentTarget.focus();
              event.preventDefault();
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              if (!drag || drag.pointerId !== event.pointerId || !panelRef.current) return;
              placeInspector(panelRef.current, drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
            }}
            onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
            onKeyDown={(event) => {
              if (isDocked) return;
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              const panel = panelRef.current;
              if (!panel) return;
              const step = event.shiftKey ? 40 : 10;
              const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
              const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
              if (!dx && !dy && event.key !== "Home") return;
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Home") { panel.style.removeProperty("left"); panel.style.removeProperty("right"); panel.style.removeProperty("--inspector-top"); }
              else placeInspector(panel, panel.offsetLeft + dx, panel.offsetTop + dy);
              persistInspectorLayout();
            }}>
            <span>控件属性</span>
            <AppIcon name="drag" size={14} />
          </button>
          {docked && <button className="inspector-detach" type="button" aria-label={isDocked ? "浮动属性面板" : "停靠属性面板"} title={isDocked ? "切换为可拖动浮窗" : "停靠到画布右侧"} onClick={() => {
            const panel = panelRef.current;
            panel?.style.removeProperty("left"); panel?.style.removeProperty("right"); panel?.style.removeProperty("--inspector-top");
            setFloating(!floating);
            requestAnimationFrame(() => persistInspectorLayout(!floating));
          }}><AppIcon name="popout" size={16} /></button>}
          <button className="inspector-collapse" type="button" aria-label={collapsed ? "展开属性面板" : "收起属性面板"} title={collapsed ? "展开" : "收起"} aria-expanded={!collapsed} aria-controls={`${panelId}-body`} onClick={() => setCollapsed(!collapsed)}>
            <AppIcon name="chevron" size={14} rotate={collapsed ? 0 : 180} />
          </button>
          <button className="inspector-close" type="button" aria-label="关闭属性面板" title="关闭" onClick={closePanel}>
            <AppIcon name="close" size={14} />
          </button>
        </div>
        <div id={`${panelId}-body`} className="inspector-body" hidden={collapsed}>
          <div className="inspector-node-heading">
            <div>
              <h4 title={displayName}>{displayName}</h4>
              <p className="inspector-node-type" title={[node.className, node.resourceId || `#${node.id}`].filter(Boolean).join("\n")}>
                {[nodeShortClass(node) !== displayName ? nodeShortClass(node) : null, node.resourceId?.replace(/^.*:id\//, "@id/") || `#${node.id}`].filter(Boolean).join(" · ")}
              </p>
            </div>
            <button className="inspector-copy" type="button" aria-label="复制节点 JSON" title="复制节点 JSON" onClick={onCopy}>
              <CopyIcon />
            </button>
          </div>
          <div className="inspector-compare-tools">
            <span className="inspector-reference-pin-wrap" tabIndex={referenceDisabledReason ? 0 : undefined} aria-label={referenceDisabledReason ?? undefined}
              title={referenceDisabledReason ?? "固定当前控件，再选择其他控件，对照名称、尺寸、文本和颜色"}>
              <button ref={referencePinRef} className="inspector-reference-pin" type="button" aria-label="固定当前控件为参考"
                disabled={Boolean(referenceDisabledReason)}
                onClick={() => setReference(pinNodeReference(root, node, imageSessionKey, source, referenceSnapshot, shownStyle))}>
                <AppIcon name="compare" size={16} />
                <span>{pinnedReference ? "更新对比参考" : "设为对比参考"}</span>
              </button>
            </span>
          </div>
          <div className="inspector-tools">
            <div className="inspector-search">
              <AppIcon name="search" size={16} />
              <input type="search" aria-label="搜索属性" placeholder="搜索属性…" title="搜索属性名称或完整值，点击结果定位" value={search} onChange={event => setSearch(event.target.value)}
                onKeyDown={event => { if (!event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && event.key === "Escape" && search) { event.preventDefault(); event.stopPropagation(); setSearch(""); } }} />
              {search && <button type="button" aria-label="清除属性搜索" onClick={event => { event.currentTarget.parentElement?.querySelector("input")?.focus(); setSearch(""); }}><AppIcon name="close" size={14} /></button>}
            </div>
            {(onSaveInspectorGroups || onOpenGroupPreferences || onColorFormatChange) && groupControls()}
          </div>
          {pinnedReference && <PinnedNodeReference key={pinnedReference.fixedAt} reference={pinnedReference} status={referenceStatus}
            format={colorFormat} aliases={colorAliases} onCopy={onCopyValue} onClose={closeReference} />}
          {colorFormatSaveError && <p className="inspector-preference-status" role="status">颜色格式已应用，本机保存失败。</p>}
          {query && <InspectorSearchResults results={searchResults.results} total={searchResults.total}
            page={searchResults.page} onPageChange={index => {
              if (activeSearch.current.scope === searchScope && activeSearch.current.active) setSearchPage({ scope: searchScope, index });
            }}
            onLocate={property => locateProperty(property, searchScope)} onCopy={onCopyValue ? (label, value) => {
              if (activeSearch.current.scope === searchScope && activeSearch.current.active) onCopyValue(label, value);
            } : undefined}
            onClear={() => { setSearch(""); panelRef.current?.querySelector<HTMLInputElement>(".inspector-search input")?.focus({ preventScroll: true }); }} />}
          {copyStatus && <p className="inspector-copy-status" role="status">{copyStatus}</p>}
          {disclosureSaveError && <p className="inspector-preference-status" role="status">属性分组与折叠状态已应用，本机保存失败。</p>}
          <SearchRevealContext.Provider value={searchRevealContext}>
          <DisclosurePreferenceContext.Provider value={disclosurePreference}>
          <div className="inspector-overview" aria-label="控件摘要">
            <section className="inspector-geometry" aria-label="位置与尺寸" data-inspector-group="layout" hidden={!groupVisible("layout")}>
              <h5>位置与尺寸 <span>{rect ? "屏幕 px · 只读" : "无有效 bounds"}</span></h5>
              <dl>{([["X", rect?.left], ["Y", rect?.top], ["W", rect?.width], ["H", rect?.height]] as const).map(([label, value]) =>
                <div key={label} data-inspector-value={valueOrDash(value)}><dt>{label}</dt><dd>
                  <span>{valueOrDash(value)}</span>{value !== undefined && copyField(`${label}（屏幕 px）`, String(value))}
                </dd></div>)}</dl>
            </section>
            {node.text && <dl className="inspector-property-list inspector-summary-text" data-inspector-group="type" hidden={!groupVisible("type")}>
              <div data-inspector-value={node.text} data-inspector-terms="text"><dt>文本</dt><dd className="inspector-copyable-value"><LongTextValue label="文本" value={node.text} />{copyField("文本", node.text)}</dd></div>
            </dl>}
            {summaryColors.length > 0 && <dl className="inspector-property-list inspector-summary-colors" hidden={!groupVisible("image")}>
              {summaryColors.map(({ label, raw, display }) => <div key={label}>
                <dt>{label}</dt><dd className="inspector-copyable-value">
                  <span className="inspector-summary-color" title={`${raw} · ${display.values.rgba}`}>
                    <span className="inspector-color-swatch" role="img" aria-label={`${label}色块，透明度保留`}><span style={{ backgroundColor: display.values.rgba }} /></span>
                    <span>{display.approximate && "≈ "}{display.value}{display.alias && <small className="inspector-color-alias">{display.alias}</small>}</span>
                  </span>{copyField(`${label} ${display.label}`, display.value)}
                </dd>
              </div>)}
            </dl>}
          </div>
          <div className="node-properties-panel">
            <InspectorGroup className="inspector-card inspector-type" disclosureId="type" hidden={!groupVisible("type")} searchKey={query && groupMatches("type") ? query : null}>
              <summary><AppIcon name="type" size={18} className="inspector-card-icon" /><span>类型</span><small title={source} data-inspector-label="采集来源" data-inspector-value={source}>{source}</small>{groupControls("type")}</summary>
              <div className="inspector-card-body">
                <p className="inspector-class-name" title={node.className ?? undefined} data-inspector-label="类名" data-inspector-value={node.className ?? undefined}><span>{node.className ? nodeShortClass(node) : "—"}</span>{copyField("类名", node.className)}</p>
                <dl className="inspector-property-list">
                  <div data-inspector-value={node.resourceId ?? undefined} data-inspector-terms="resource-id"><dt>资源 ID</dt><dd className="inspector-copyable-value"><LongTextValue label="资源 ID" value={valueOrDash(node.resourceId?.replace(/^.*:id\//, "@id/"))} />{copyField("资源 ID", node.resourceId)}</dd></div>
                </dl>
                <InspectorGroup className="inspector-subsection inspector-identity" disclosureId="identity" searchKey={reveal("完整类名 class 显示名称 名称来源 文本 text 描述 content-desc 包名 package 继承链 父类 SDK", ...semanticSearchValues, node.className, displayName, nameSource, node.text, node.contentDesc, node.package, classHierarchy?.join(" "))}>
                  <summary>名称与继承</summary>
                  <dl className="inspector-property-list">
                    <div data-inspector-value={node.className ?? undefined}><dt>完整类名</dt><dd>{textValue("完整类名", node.className)}</dd></div>
                    <div><dt>显示名称</dt><dd title={displayName}>{textValue("显示名称", displayName)}</dd></div>
                    <div><dt>名称来源</dt><dd>{nameSource}</dd></div>
                    {semantics.map(([label, key, value]) => <div key={key} data-inspector-value={value} data-inspector-terms={key}><dt>{label}</dt><dd className="inspector-copyable-value"><LongTextValue label={label} value={value} />{copyField(label, value)}</dd></div>)}
                    <div data-inspector-value={node.contentDesc ?? undefined} data-inspector-terms="content-desc"><dt>描述</dt><dd>{textValue("描述", node.contentDesc)}</dd></div>
                    <div data-inspector-value={node.package ?? undefined} data-inspector-terms="package"><dt>包名</dt><dd>{textValue("包名", node.package)}</dd></div>
                  </dl>
                  {classHierarchy && <InspectorGroup className="inspector-subsection inspector-class-chain" disclosureId="class-chain" searchKey={reveal("继承链 父类 SDK", classHierarchy.join(" "))}>
                    <summary>继承链 · {classHierarchy.length} 层（SDK）</summary>
                    <dl className="inspector-property-list">
                      {classHierarchy.map((name, index) => <div key={`${index}-${name}`}><dt>{index === 0 ? "控件" : "父类"}</dt><dd title={name}>{textValue(index === 0 ? "控件" : "父类", name)}</dd></div>)}
                    </dl>
                  </InspectorGroup>}
                </InspectorGroup>
              </div>
            </InspectorGroup>
            {debugMetadata && <InspectorGroup className="inspector-card inspector-business" disclosureId="business" hidden={!groupVisible("business")} searchKey={query && groupMatches("business") ? query : null}>
              <summary><AppIcon name="business" size={18} className="inspector-card-icon" /><span>业务信息</span><small>只读</small>{groupControls("business")}</summary>
              <div className="inspector-card-body">
                <p className="inspector-business-source">Debug SDK · 显式登记 · 随控件树采集</p>
                {debugMetadata.status === "omitted-budget" ? <p className="inspector-image-note" data-inspector-label="业务信息状态" data-inspector-value="omitted-budget">该控件登记的业务信息超过本次采集额度，未保存具体值。</p>
                  : debugMetadata.groups.map(group => <InspectorGroup key={`${node.id}:${group.key}`} className="inspector-subsection inspector-business-group" defaultOpen
                    hidden={!businessMatchAll && !matches(...groupValues(group))} searchKey={query && (businessMatchAll || matches(...groupValues(group))) ? query : null}>
                    <summary title={group.key}>{group.label}</summary>
                    <DebugMetadataFields fields={group.fields} groupLabel={group.label} pathPrefix={group.key} query={query}
                      context={{ nodeName: displayName, source: "Debug SDK · 显式登记 · 随控件树采集" }}
                      disabled={!visible || collapsed || Boolean(navigationDisabled || refreshBusy) || !groupVisible("business")}
                      scope={businessDisclosureScope} revealRequest={searchRevealContext.request} onCopyValue={onCopyValue} />
                  </InspectorGroup>)}
              </div>
            </InspectorGroup>}
            <InspectorGroup className="inspector-card inspector-relation" disclosureId="relation" hidden={!groupVisible("relation")} searchKey={query && groupMatches("relation") ? query : null}>
              <summary><span className="inspector-card-icon" aria-hidden="true"><AppIcon name="link" size={18} /></span><span>关系</span>{groupControls("relation")}</summary>
              <div className="inspector-card-body">
                {onNavigateNode && <NodePathNavigator root={root} node={node} disabled={navigationDisabled} onNavigate={onNavigateNode} />}
                {parent ? <InspectorGroup className="inspector-parent-details" disclosureId="parent-details" searchKey={reveal("父容器 parent", parentName, parent.className, parent.id)}>
                  <summary aria-label="父容器详情" title="展开查看父容器的完整名称、类名和节点 ID">
                    <div>
                      <p className="inspector-node-parent" title={`${parentName}\n${parent.className ?? ""}\n#${parent.id}`}>父容器 · <span>{parentName}</span></p>
                      <p className="inspector-parent-type" title={parent.className ?? undefined}>{nodeShortClass(parent)}</p>
                    </div>
                  </summary>
                  <dl className="inspector-property-list">
                    <div><dt>显示名称</dt><dd>{parentName}</dd></div>
                    <div><dt>完整类名</dt><dd>{valueOrDash(parent.className)}</dd></div>
                    <div><dt>节点 ID</dt><dd className="inspector-copyable-value"><span>{parent.id}</span>{copyField("父节点 ID", parent.id)}</dd></div>
                  </dl>
                </InspectorGroup> : <p className="inspector-node-parent" title={parentName} data-inspector-label="父容器" data-inspector-value={parentName}>父容器 · <span>{parentName}</span></p>}
                <dl className="inspector-inline-values">
                  <div><dt>子节点</dt><dd>{metrics.childCount}</dd></div>
                  <div><dt>层级</dt><dd>{metrics.depth}</dd></div>
                  <div><dt>序号</dt><dd>{valueOrDash(node.index)}</dd></div>
                </dl>
              </div>
            </InspectorGroup>
            <InspectorGroup className="inspector-card inspector-layout" disclosureId="layout" hidden={!groupVisible("layout")} searchKey={query && groupMatches("layout") ? query : null}>
              <summary><span className="inspector-card-icon" aria-hidden="true"><AppIcon name="layout" size={18} /></span><span>布局</span><small>屏幕 px</small>{groupControls("layout")}</summary>
              <div className="inspector-card-body">
                <dl className="inspector-property-list">
                  <div data-inspector-value={parentOffset ? `${parentOffset.x} / ${parentOffset.y}` : undefined}><dt>父级内偏移</dt><dd>{parentOffset ? `${px(parentOffset.x)} / ${px(parentOffset.y)}` : "—"}</dd></div>
                </dl>
                {hasSdkLayoutRule && <InspectorGroup className="inspector-subsection inspector-layout-rules" disclosureId="layout-rules" searchKey={reveal("原生布局规则 gravity 重力 权重 constraint 约束 对齐 偏置 宽高比", ...ruleSearchValues, node.attributes?.["sdk-layout-weight"], node.attributes?.["sdk-layout-rules"])}>
                  <summary>原生布局规则 · {layoutRules?.type ?? "Android"}</summary>
                  <dl className="inspector-property-list">
                    {node.attributes?.["sdk-layout-gravity"] !== undefined && <div data-inspector-value={node.attributes["sdk-layout-gravity"]} data-inspector-terms="gravity"><dt>重力方向</dt><dd title={`Android gravity=${node.attributes["sdk-layout-gravity"]}`}>{gravityLabel(node.attributes["sdk-layout-gravity"])}</dd></div>}
                    {node.attributes?.["sdk-layout-weight"] !== undefined && <div data-inspector-value={node.attributes["sdk-layout-weight"]}><dt>布局权重</dt><dd>{valueOrDash(node.attributes["sdk-layout-weight"])}</dd></div>}
                    {layoutRules && <LayoutRuleProperties root={root} node={node} rules={layoutRules}
                      onNavigateNode={onNavigateNode} navigationDisabled={navigationDisabled} onCopyValue={onCopyValue} />}
                  </dl>
                </InspectorGroup>}
                <InspectorGroup className="inspector-subsection inspector-extra-geometry" disclosureId="extra-geometry" searchKey={reveal("更多几何信息 右 下 中心 面积 Z LayoutParams 布局宽 高 bounds 截图尺寸", ...geometrySearchValues)}>
                  <summary>更多几何信息</summary>
                  <dl className="inspector-property-list">
                    <div data-inspector-value={rect ? `${rect.right} / ${rect.bottom}` : undefined}><dt>右 / 下</dt><dd>{px(rect?.right)} / {px(rect?.bottom)}</dd></div>
                    <div data-inspector-value={rect ? `${rect.centerX} / ${rect.centerY}` : undefined}><dt>中心点</dt><dd>{px(rect?.centerX)} / {px(rect?.centerY)}</dd></div>
                    <div data-inspector-value={rect ? String(rect.area) : undefined}><dt>面积</dt><dd>{rect ? `${Math.round(rect.area).toLocaleString("zh-CN")} px²` : "—"}</dd></div>
                    <div data-inspector-value={node.attributes?.z}><dt>原生 Z</dt><dd>{valueOrDash(node.attributes?.z)}</dd></div>
                    <div data-inspector-value={node.attributes?.["sdk-layout-params-class"]}><dt>LayoutParams</dt><dd>{valueOrDash(node.attributes?.["sdk-layout-params-class"])}</dd></div>
                    <div data-inspector-value={`${node.attributes?.["sdk-layout-width"] ?? "—"} / ${node.attributes?.["sdk-layout-height"] ?? "—"}`}><dt>布局宽 / 高</dt><dd>{layoutDimension(node.attributes?.["sdk-layout-width"])} / {layoutDimension(node.attributes?.["sdk-layout-height"])}</dd></div>
                    <div><dt>bounds</dt><dd>{valueOrDash(node.bounds?.raw)}</dd></div>
                    <div><dt>截图尺寸</dt><dd>{screenshotSize ? `${screenshotSize.width} × ${screenshotSize.height}px` : "—"}</dd></div>
                  </dl>
                </InspectorGroup>
                <InspectorGroup className="inspector-subsection inspector-padding" disclosureId="padding" searchKey={reveal("内边距 padding 外边距 margin 边框 border", JSON.stringify(padding), marginLabel, borderWidth)}>
                  <summary>内边距与边框</summary>
                  <section aria-label="布局盒模型">
                    <div className="box-model-card" aria-label="控件外框与内边距">
                      <div className="box-model-size" title="屏幕 bounds，不与本地 padding 相减来推算内容尺寸">
                        <span>外框 <small>bounds</small></span>
                        <strong>{rect ? `${Math.round(rect.width * 100) / 100} × ${Math.round(rect.height * 100) / 100}` : "—"}<small> 屏幕 px</small></strong>
                      </div>
                      <div className="box-model-caption"><span>内边距 <small>padding</small></span><small>本地 px</small></div>
                      {padding.some(({ value }) => value !== null) ? <div className="box-model-diagram" role="group" aria-label="四边内边距">
                        {padding.map(({ side, label, value }) => <div key={side} className={`box-model-edge edge-${side}${value === null ? " is-unknown" : ""}`} data-padding-side={side} data-inspector-label={`${label}内边距`} data-inspector-value={node.attributes?.[`padding-${side}`] ?? "—"} data-inspector-terms={`padding-${side}`} aria-label={`${label}内边距：${value === null ? "未采集" : px(value)}`}>
                          <span>{label}</span><strong>{value === null ? "—" : Math.round(value * 100) / 100}</strong>
                        </div>)}
                        <div className="box-model-content"><span>内容区域</span><small>未采集</small></div>
                      </div> : <p className="box-model-empty" data-inspector-label="内边距" data-inspector-value="未采集" data-inspector-terms="padding">内边距未采集</p>}
                      <dl className="box-model-extra">
                        <div data-inspector-value={measuredMargins.some(value => value !== null) ? margins.map(value => value ?? "—").join(" / ") : "—"}><dt>margin</dt><dd title={marginLabel === "—" ? "外边距未采集" : "SDK LayoutParams：上 / 右 / 下 / 左，本地 px"}>{marginLabel}</dd></div>
                        <div data-inspector-value={borderWidth === null ? "—" : node.attributes?.["border-width"]}><dt>border</dt><dd title={node.attributes?.["border-status"] ?? "边框宽度未采集"}>{px(borderWidth)}</dd></div>
                      </dl>
                    </div>
                    <p className="box-model-note">— 表示未采集或值无效，不是 0。内容尺寸不由外框推算。</p>
                  </section>
                </InspectorGroup>
              </div>
            </InspectorGroup>
            {hasSdkInteraction && <InspectorGroup className="inspector-card inspector-interaction" disclosureId="interaction" hidden={!groupVisible("interaction")} searchKey={query && groupMatches("interaction") ? query : null}>
              <summary><span className="inspector-card-icon" aria-hidden="true"><AppIcon name="cursor" size={18} /></span><span>交互</span><small>SDK View 标志</small>{groupControls("interaction")}</summary>
              <div className="inspector-card-body">
                <dl className="inspector-property-list">
                  <div data-inspector-value={String(node.clickable)} data-inspector-terms="clickable"><dt>可点击</dt><dd>{node.clickable ? "是" : "否"}</dd></div>
                  {sdkInteractions.map(([label, key]) => {
                    const flag = node.attributes?.[key];
                    return <div key={key} data-inspector-value={flag} data-inspector-terms={key}><dt>{label}</dt><dd>{flag === "true" ? "是" : flag === "false" ? "否" : "—"}</dd></div>;
                  })}
                </dl>
                <p className="inspector-image-note">点击监听器仅指标准 OnClickListener；“否”不代表控件或子项不能响应手势。</p>
              </div>
            </InspectorGroup>}
            <InspectorGroup className="inspector-card inspector-image" disclosureId="image" hidden={!groupVisible("image")} searchKey={query && groupMatches("image") ? query : null}>
              <summary><span className="inspector-card-icon" aria-hidden="true"><AppIcon name="image" size={18} /></span><span>画面</span>{groupControls("image")}</summary>
              <div className="inspector-card-body">
                <NodePresentationStatus status={presentationStatus} />
                {node.attributes?.["image-capture-error"] && <p className="inspector-image-note" data-inspector-label="采集失败原因" data-inspector-value={node.attributes["image-capture-error"]}>原因：{node.attributes["image-capture-error"]}</p>}
                {node.attributes?.["image-refresh-error"] && <p className="inspector-image-note" data-inspector-label="上次刷新失败" data-inspector-value={node.attributes["image-refresh-error"]}>上次刷新失败，保留旧画面：{node.attributes["image-refresh-error"]}</p>}
                {node.attributes?.["image-source"] && <p className="inspector-image-note" data-inspector-label="画面来源" data-inspector-value={node.attributes["image-source"]}>来源：{node.attributes["image-source"]}</p>}
                <NodeImageActions root={root} node={node} groupImage={groupImage} sessionKey={imageSessionKey} controller={imageController} />
                {onReadStyle && <button className="inspector-style-read" type="button" disabled={styleBusy} onClick={() => void readStyle()}>{styleBusy ? "正在读取样式…" : "读取实时样式"}</button>}
                {onRefresh && <button className="inspector-image-refresh" type="button" disabled={refreshBusy} onClick={onRefresh}>{refreshBusy ? "正在刷新…" : "刷新当前控件"}</button>}
                {onRefreshBranch && <button className="inspector-image-refresh" type="button" disabled={refreshBusy} onClick={onRefreshBranch}>{refreshBusy ? "正在刷新…" : "刷新此分支"}</button>}
                {onRefreshList && <button className="inspector-image-refresh" type="button" disabled={refreshBusy} onClick={onRefreshList}>{refreshBusy ? "正在刷新…" : "刷新可见项（分批）"}</button>}
                {styleError && <p className="inspector-image-note" role="status">{styleError}</p>}
                {shownStyle && <>
                  <p className="inspector-image-note">Debug SDK 实时读取 · {new Date(shownStyle.capturedAtMillis).toLocaleString()} · 不修改快照</p>
                  <dl className="inspector-property-list">
                    <div data-inspector-value={shownStyle.backgroundType ?? undefined}><dt>背景类型</dt><dd>{shownStyle.backgroundType ?? "无背景"}</dd></div>
                    <ColorProperty label="背景源色" raw={shownStyle.backgroundColor} encoding="android-argb" aliases={colorAliases} onCopy={onCopyValue} scope={searchScope} format={colorFormat} search={query} revealRevision={searchReveal?.scope === searchScope ? searchReveal.revision : undefined}
                      fallback={shownStyle.backgroundType ? "非单一纯色或未暴露" : "—"} />
                    {shownStyle.textColor && <ColorProperty label="当前文字色" raw={shownStyle.textColor} encoding="android-argb" aliases={colorAliases} onCopy={onCopyValue} scope={searchScope} format={colorFormat} search={query} revealRevision={searchReveal?.scope === searchScope ? searchReveal.revision : undefined} />}
                    {shownStyle.textSizePx !== null && <div data-inspector-value={String(shownStyle.textSizePx)}><dt>文字大小</dt><dd>{Math.round(shownStyle.textSizePx * 100) / 100}px</dd></div>}
                  </dl>
                </>}
                {refreshStatus && <p className="inspector-image-note" role="status">{refreshStatus}</p>}
                <dl className="inspector-inline-values">
                  <div data-inspector-value={String(node.visibleToUser)} data-inspector-terms="visible"><dt>设备可见</dt><dd>{node.visibleToUser ? "是" : "否"}</dd></div>
                  <div data-inspector-value={String(node.clickable)} data-inspector-terms="clickable"><dt>可点击</dt><dd>{node.clickable ? "是" : "否"}</dd></div>
                </dl>
                {(node.attributes?.["image-source"] || node.attributes?.["image-capture-error"] || node.layerImageStatus === "style" || hasQmlColors) && <InspectorGroup className="inspector-subsection inspector-image-details" disclosureId="image-details" searchKey={reveal("采集与样式详情 画面来源 刷新时间 补采说明 背景色 background-color 边框色 border-color 颜色 别名 Hex RGBA 透明度 边框状态 圆角 corner-radii", ...qmlColorTerms, ...["image-source", "image-refreshed-at", "image-capture-error", "background-color", "border-color", "border-status", "corner-radii"].map(key => node.attributes?.[key]))}>
                  <summary>采集与样式详情</summary>
                  <dl className="inspector-property-list">
                    {node.attributes?.["image-source"] && <div data-inspector-value={node.attributes["image-source"]}><dt>画面来源</dt><dd>{node.attributes["image-source"]}</dd></div>}
                    {node.attributes?.["image-refreshed-at"] && <div data-inspector-value={node.attributes["image-refreshed-at"]}><dt>刷新时间</dt><dd>{new Date(node.attributes["image-refreshed-at"]).toLocaleString()}</dd></div>}
                    {node.attributes?.["image-capture-error"] && <div data-inspector-value={node.attributes["image-capture-error"]}><dt>补采说明</dt><dd>{node.attributes["image-capture-error"]}</dd></div>}
                    {(node.layerImageStatus === "style" || hasQmlColors) && <>
                      {hasQmlColors ? <>
                        <ColorProperty label="背景源色" raw={node.attributes?.["background-color"]} encoding="qml-rgba" aliases={colorAliases} onCopy={onCopyValue} scope={searchScope} format={colorFormat} search={query} revealRevision={searchReveal?.scope === searchScope ? searchReveal.revision : undefined} />
                        <ColorProperty label="边框源色" raw={node.attributes?.["border-color"]} encoding="qml-rgba" aliases={colorAliases} onCopy={onCopyValue} scope={searchScope} format={colorFormat} search={query} revealRevision={searchReveal?.scope === searchScope ? searchReveal.revision : undefined} />
                      </> : <>
                        <div data-inspector-value={node.attributes?.["background-color"]}><dt>背景色</dt><dd>{valueOrDash(node.attributes?.["background-color"])}</dd></div>
                        <div data-inspector-value={node.attributes?.["border-color"]}><dt>边框色</dt><dd>{valueOrDash(node.attributes?.["border-color"])}</dd></div>
                      </>}
                      <div data-inspector-value={node.attributes?.["border-status"]}><dt>边框状态</dt><dd>{valueOrDash(node.attributes?.["border-status"])}</dd></div>
                      <div data-inspector-value={node.attributes?.["corner-radii"]}><dt>圆角</dt><dd>{node.attributes?.["corner-radii"] ? `${node.attributes["corner-radii"]}px` : "—"}</dd></div>
                    </>}
                  </dl>
                  {hasQmlColors && <p className="inspector-image-note">QML 属性源色；渐变、边框启用及控件/祖先透明度仍以原属性为准。</p>}
                </InspectorGroup>}
              </div>
            </InspectorGroup>
            <InspectorGroup className="inspector-card inspector-more" disclosureId="raw" hidden={!groupVisible("raw")} searchKey={query && groupMatches("raw") ? query : null}>
              <summary><span className="inspector-card-icon" aria-hidden="true"><AppIcon name="document" size={18} /></span><span>原始属性与定位</span>{groupControls("raw")}</summary>
              <div className="inspector-card-body">
                <p className="node-id" data-inspector-label="节点 ID" data-inspector-value={node.id}>#{node.id}</p>
                <dl className="inspector-property-list"><div><dt>flags</dt><dd>{flags}</dd></div></dl>
                {children}
              </div>
            </InspectorGroup>
          </div>
          </DisclosurePreferenceContext.Provider>
          </SearchRevealContext.Provider>
          {!hasVisibleGroup && (query
            ? <p className="inspector-search-empty" role="status">没有匹配的属性分组</p>
            : <div className="inspector-groups-empty" role="status">
              <p>当前控件的属性分组已全部隐藏。</p>
              <p>搜索仍能查看属性，也可以在偏好设置中恢复分组。</p>
              {onOpenGroupPreferences && <button type="button" onClick={onOpenGroupPreferences}>设置属性分组</button>}
            </div>)}
        </div>
        {layoutSaveError && <p className="inspector-layout-error" role="status">布局仅在本次窗口生效，本机保存失败。</p>}
        {!isDocked && !collapsed && <FloatingInspectorResize panelRef={panelRef} onSave={() => { persistInspectorLayout(); }} />}
      </aside>
    </>
  );
}
