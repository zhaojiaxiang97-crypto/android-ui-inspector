import { useEffect, useId, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PixelSize, UiNode, ViewStyleResult } from "../../shared/types";
import { nodeMetrics } from "../../shared/node-metrics";
import { nodeDisplayLabel, nodeShortClass } from "../../shared/tree-utils";

type Props = {
  root: UiNode;
  node: UiNode;
  screenshotSize: PixelSize | null;
  toolbarHost: HTMLElement | null;
  onCopy: () => void;
  copyStatus: string | null;
  onRefresh?: () => void;
  onRefreshBranch?: () => void;
  onReadStyle?: () => Promise<ViewStyleResult>;
  refreshBusy?: boolean;
  refreshStatus?: string | null;
  children: ReactNode;
};

function valueOrDash(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function px(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : `${Math.round(value * 100) / 100}px`;
}

function layoutDimension(value: string | undefined) {
  return value === "-1" ? "match_parent" : value === "-2" ? "wrap_content" : value === undefined ? "—" : `${value}px`;
}

function gravityLabel(raw: string | undefined) {
  if (raw === undefined) return "—";
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

export function NodePropertiesPanel({ root, node, screenshotSize, toolbarHost, onCopy, copyStatus, onRefresh, onRefreshBranch, onReadStyle, refreshBusy, refreshStatus, children }: Props) {
  const [visible, setVisible] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [search, setSearch] = useState("");
  const [style, setStyle] = useState<{ root: UiNode; value: ViewStyleResult } | null>(null);
  const [styleError, setStyleError] = useState<string | null>(null);
  const [styleBusy, setStyleBusy] = useState(false);
  const styleRequest = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const panelId = useId();
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
    const canvas = workspace.querySelector<HTMLElement>(".screenshot-frame");
    const observer = new ResizeObserver(() => {
      const height = Math.min(workspace.clientHeight, canvas ? canvas.offsetTop + canvas.offsetHeight : workspace.clientHeight);
      panel.style.setProperty("--inspector-viewport-height", `${height}px`);
      panel.style.setProperty("--inspector-min-top", `${(canvas?.offsetTop ?? 0) + 12}px`);
      if (panel.style.left) placeInspector(panel, panel.offsetLeft, panel.offsetTop);
    });
    observer.observe(panel);
    observer.observe(workspace);
    if (canvas) observer.observe(canvas);
    return () => observer.disconnect();
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
  }

  const metrics = useMemo(() => nodeMetrics(root, node, screenshotSize), [node, root, screenshotSize]);
  const shownStyle = style?.root === root && style.value.ref === node.attributes?.["view-ref"] ? style.value : null;
  const displayName = nodeDisplayLabel(node);
  const nameSource = node.attributes?.["debug-name"]?.trim() ? "Debug App 显式名称"
    : node.text?.trim() ? "控件文本" : node.contentDesc?.trim() ? "内容描述"
    : node.resourceId ? "资源 ID" : "真实类名";
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
  const marginLabel = margins.every(value => value !== undefined) ? margins.map(value => `${value}px`).join(" / ") : "—";
  const hasSdkLayoutRule = node.attributes?.["sdk-layout-gravity"] !== undefined || node.attributes?.["sdk-layout-weight"] !== undefined;
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
    : sourceValue === "debug-qml" ? "QML Debug" : sourceValue === "debug-view" ? "View Debug" : sourceValue || "来源未标注";
  const imageStatus = node.layerImageStatus ? {
    captured: node.layerImageEmpty === true ? "采集画面全透明，仅显示边框" : node.layerImageEmpty === false ? "已采集独立画面，含可见像素" : "已采集独立画面（透明度未检测）",
    style: "QML 真实样式重建（非独立截图）",
    unavailable: node.attributes?.["skip-draw"] === "true" ? "结构容器，系统跳过自身绘制" : "未返回独立位图，不代表控件透明",
    ambiguous: "匹配有歧义，未使用位图",
    hidden: "控件或祖先不可见",
    failed: "独立画面采集失败",
  }[node.layerImageStatus] : "当前数据无独立位图状态";
  const imageLabel = node.layerImageStatus ? {
    captured: node.layerImageEmpty === true ? "全透明" : "已采集",
    style: "样式重建", unavailable: "未返回", ambiguous: "匹配歧义", hidden: "不可见", failed: "采集失败",
  }[node.layerImageStatus] : "未采集";
  const query = search.trim().toLocaleLowerCase();
  const matches = (...values: unknown[]) => values.some(value => String(value ?? "").toLocaleLowerCase().includes(query));
  const matching = {
    type: matches("类型 class 名称 来源 继承 父类 资源 ID resource-id 文本 text content-desc 描述 package 包名", source, displayName, nameSource, classHierarchy?.join(" "), node.className, node.resourceId, node.package, node.text, node.contentDesc),
    relation: matches("关系 relation 父容器 parent 子节点 children 层级 depth index 序号", parentName, parent?.className, parent?.id, metrics.childCount, metrics.depth, node.index),
    layout: matches("布局 layout 位置 尺寸 geometry bounds 屏幕 px X Y W H width height 右 下 中心 面积 Z 父级内偏移 截图 padding 内边距 margin 外边距 border 边框 LayoutParams gravity weight 重力 权重", node.bounds?.raw, JSON.stringify(rect), JSON.stringify(padding), marginLabel, node.attributes?.["sdk-layout-params-class"], node.attributes?.["sdk-layout-gravity"], node.attributes?.["sdk-layout-weight"], borderWidth, node.attributes?.z),
    interaction: hasSdkInteraction && matches("交互 点击 长按 上下文 点击监听器 按下 激活 SDK View", ...sdkInteractions.map(([, key]) => node.attributes?.[key])),
    image: matches("画面 image 样式 style 文本色 字号 设备可见 visible 可点击 clickable 背景色 background-color 边框色 border-color 圆角 corner-radii", imageStatus, imageLabel, node.visibleToUser ? "是" : "否", node.clickable ? "是" : "否", shownStyle?.backgroundType, shownStyle?.backgroundColor, shownStyle?.textColor, ...["image-source", "image-capture-error", "background-color", "border-color", "corner-radii"].map(key => node.attributes?.[key])),
    raw: matches("原始属性 调试 定位 XPath UiSelector ADB JSON XML PNG 导出 flags", node.id, flags, JSON.stringify(node.attributes)),
  };

  return (
    <>
      {toolbarHost && createPortal(
        <button ref={toggleRef} className="inspector-toggle" type="button" aria-label="显示或隐藏属性面板" title="属性面板" aria-expanded={visible} aria-controls={panelId}
          onClick={() => { setVisible(!visible); setCollapsed(false); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16M18 8h1M18 12h1" /></svg>
        </button>, toolbarHost)}
      <aside id={panelId} ref={panelRef} className={`floating-inspector ${collapsed ? "is-collapsed" : ""}`} hidden={!visible} data-node-id={node.id} aria-label="节点属性"
        onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") closePanel(); }}>
        <div className="inspector-tab">
          <button className="inspector-drag-handle" type="button" aria-label="移动属性面板" title="拖动移动 · 方向键微调 · Home 复位"
            onPointerDown={(event) => {
              if (event.button !== 0 || !panelRef.current) return;
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
            }}>
            <span>属性</span>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><circle cx="4" cy="4" r="1" /><circle cx="10" cy="4" r="1" /><circle cx="4" cy="10" r="1" /><circle cx="10" cy="10" r="1" /></svg>
          </button>
          <button className="inspector-collapse" type="button" aria-label={collapsed ? "展开属性面板" : "收起属性面板"} title={collapsed ? "展开" : "收起"} aria-expanded={!collapsed} aria-controls={`${panelId}-body`} onClick={() => setCollapsed(!collapsed)}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={collapsed ? "M4 6l4 4 4-4" : "M4 10l4-4 4 4"} /></svg>
          </button>
          <button className="inspector-close" type="button" aria-label="关闭属性面板" title="关闭" onClick={closePanel}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
          </button>
        </div>
        <div id={`${panelId}-body`} className="inspector-body" hidden={collapsed}>
          <div className="inspector-search">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.5" /><path d="m10 10 4 4" /></svg>
            <input type="search" aria-label="搜索属性" placeholder="搜索属性…" title="按属性名称或值筛选分组" value={search} onChange={event => setSearch(event.target.value)}
              onKeyDown={event => { if (event.key === "Escape" && search) { event.preventDefault(); event.stopPropagation(); setSearch(""); } }} />
            {search && <button type="button" aria-label="清除属性搜索" onClick={event => { event.currentTarget.parentElement?.querySelector("input")?.focus(); setSearch(""); }}>×</button>}
          </div>
          <div className="inspector-node-heading">
            <div>
              <h4 title={displayName}>{displayName}</h4>
              <p className="inspector-node-type" title={[node.className, node.resourceId || `#${node.id}`].filter(Boolean).join("\n")}>
                {nodeShortClass(node)} · {node.resourceId?.replace(/^.*:id\//, "@id/") || `#${node.id}`}
              </p>
            </div>
            <button className="inspector-copy" type="button" aria-label="复制节点 JSON" title="复制节点 JSON" onClick={onCopy}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="5" y="5" width="8" height="8" rx="1" /><path d="M10 3H3v7" /></svg>
            </button>
          </div>
          {copyStatus && <p className="inspector-copy-status" role="status">{copyStatus}</p>}
          <div className="node-properties-panel">
            <details className="inspector-card inspector-type" open hidden={!matching.type}>
              <summary><span className="inspector-card-icon" aria-hidden="true">C</span><span>类型</span><small>{source}</small></summary>
              <div className="inspector-card-body">
                <p className="inspector-class-name">{valueOrDash(node.className)}</p>
                <dl className="inspector-property-list">
                  <div><dt>显示名称</dt><dd title={displayName}>{displayName}</dd></div>
                  <div><dt>名称来源</dt><dd>{nameSource}</dd></div>
                  <div><dt>资源 ID</dt><dd title={node.resourceId ?? undefined}>{valueOrDash(node.resourceId?.replace(/^.*:id\//, "@id/"))}</dd></div>
                </dl>
                {classHierarchy && <details className="inspector-subsection inspector-class-chain">
                  <summary>继承链 · {classHierarchy.length} 层（SDK）</summary>
                  <dl className="inspector-property-list">
                    {classHierarchy.map((name, index) => <div key={`${index}-${name}`}><dt>{index === 0 ? "控件" : "父类"}</dt><dd title={name}>{name}</dd></div>)}
                  </dl>
                </details>}
                <details className="inspector-subsection">
                  <summary>文本与标识</summary>
                  <dl className="inspector-property-list">
                    <div><dt>文本</dt><dd>{valueOrDash(node.text)}</dd></div>
                    <div><dt>描述</dt><dd>{valueOrDash(node.contentDesc)}</dd></div>
                    <div><dt>包名</dt><dd>{valueOrDash(node.package)}</dd></div>
                  </dl>
                </details>
              </div>
            </details>
            <details className="inspector-card inspector-relation" open hidden={!matching.relation}>
              <summary><span className="inspector-card-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="m6 10 4-4M6 6l2-2a3 3 0 0 1 4 4l-2 2M10 10l-2 2a3 3 0 0 1-4-4l2-2" /></svg></span><span>关系</span></summary>
              <div className="inspector-card-body">
                <p className="inspector-node-parent" title={parent ? `${parentName}\n${parent.className ?? ""}\n#${parent.id}` : parentName}>父容器 · <span>{parentName}</span></p>
                {parent && <p className="inspector-parent-type" title={parent.className ?? undefined}>{nodeShortClass(parent)}</p>}
                <dl className="inspector-inline-values">
                  <div><dt>子节点</dt><dd>{metrics.childCount}</dd></div>
                  <div><dt>层级</dt><dd>{metrics.depth}</dd></div>
                  <div><dt>序号</dt><dd>{valueOrDash(node.index)}</dd></div>
                </dl>
              </div>
            </details>
            <details className="inspector-card inspector-layout" open hidden={!matching.layout}>
              <summary><span className="inspector-card-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="3" y="3" width="10" height="10" rx="1" /><path d="M1 5h4M1 11h4M11 1v4M5 11v4" /></svg></span><span>布局</span><small>屏幕 px</small></summary>
              <div className="inspector-card-body">
                <section className="inspector-geometry" aria-label="位置与尺寸">
                  <h5>屏幕边界 <span>{rect ? "bounds · 只读" : "无有效 bounds"}</span></h5>
                  <dl>{[["X", rect?.left], ["Y", rect?.top], ["W", rect?.width], ["H", rect?.height]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{valueOrDash(value)}</dd></div>)}</dl>
                </section>
                <dl className="inspector-property-list">
                  <div><dt>父级内偏移</dt><dd>{parentOffset ? `${px(parentOffset.x)} / ${px(parentOffset.y)}` : "—"}</dd></div>
                </dl>
                {hasSdkLayoutRule && <details className="inspector-subsection inspector-layout-rules">
                  <summary>原生布局规则（SDK）</summary>
                  <dl className="inspector-property-list">
                    {node.attributes?.["sdk-layout-gravity"] !== undefined && <div><dt>重力方向</dt><dd title={`Android gravity=${node.attributes["sdk-layout-gravity"]}`}>{gravityLabel(node.attributes["sdk-layout-gravity"])}</dd></div>}
                    {node.attributes?.["sdk-layout-weight"] !== undefined && <div><dt>布局权重</dt><dd>{valueOrDash(node.attributes["sdk-layout-weight"])}</dd></div>}
                  </dl>
                </details>}
                <details className="inspector-subsection">
                  <summary>更多几何信息</summary>
                  <dl className="inspector-property-list">
                    <div><dt>右 / 下</dt><dd>{px(rect?.right)} / {px(rect?.bottom)}</dd></div>
                    <div><dt>中心点</dt><dd>{px(rect?.centerX)} / {px(rect?.centerY)}</dd></div>
                    <div><dt>面积</dt><dd>{rect ? `${Math.round(rect.area).toLocaleString("zh-CN")} px²` : "—"}</dd></div>
                    <div><dt>原生 Z</dt><dd>{valueOrDash(node.attributes?.z)}</dd></div>
                    <div><dt>LayoutParams</dt><dd>{valueOrDash(node.attributes?.["sdk-layout-params-class"])}</dd></div>
                    <div><dt>布局宽 / 高</dt><dd>{layoutDimension(node.attributes?.["sdk-layout-width"])} / {layoutDimension(node.attributes?.["sdk-layout-height"])}</dd></div>
                    <div><dt>bounds</dt><dd>{valueOrDash(node.bounds?.raw)}</dd></div>
                    <div><dt>截图尺寸</dt><dd>{screenshotSize ? `${screenshotSize.width} × ${screenshotSize.height}px` : "—"}</dd></div>
                  </dl>
                </details>
                <details className="inspector-subsection inspector-padding">
                  <summary>内边距与边框</summary>
                  <section aria-label="布局盒模型">
                    <div className="box-model-card" aria-label="控件外框与内边距">
                      <div className="box-model-size" title="屏幕 bounds，不与本地 padding 相减来推算内容尺寸">
                        <span>外框 <small>bounds</small></span>
                        <strong>{rect ? `${Math.round(rect.width * 100) / 100} × ${Math.round(rect.height * 100) / 100}` : "—"}<small> 屏幕 px</small></strong>
                      </div>
                      <div className="box-model-caption"><span>内边距 <small>padding</small></span><small>本地 px</small></div>
                      {padding.some(({ value }) => value !== null) ? <div className="box-model-diagram" role="group" aria-label="四边内边距">
                        {padding.map(({ side, label, value }) => <div key={side} className={`box-model-edge edge-${side}${value === null ? " is-unknown" : ""}`} data-padding-side={side} aria-label={`${label}内边距：${value === null ? "未采集" : px(value)}`}>
                          <span>{label}</span><strong>{value === null ? "—" : Math.round(value * 100) / 100}</strong>
                        </div>)}
                        <div className="box-model-content"><span>内容区域</span><small>未采集</small></div>
                      </div> : <p className="box-model-empty">内边距未采集</p>}
                      <dl className="box-model-extra">
                        <div><dt>margin</dt><dd title={marginLabel === "—" ? "外边距未采集" : "SDK LayoutParams：上 / 右 / 下 / 左，本地 px"}>{marginLabel}</dd></div>
                        <div><dt>border</dt><dd title={node.attributes?.["border-status"] ?? "边框宽度未采集"}>{px(borderWidth)}</dd></div>
                      </dl>
                    </div>
                    <p className="box-model-note">— 表示未采集，不是 0。内容尺寸不由外框推算。</p>
                  </section>
                </details>
              </div>
            </details>
            {hasSdkInteraction && <details className="inspector-card inspector-interaction" hidden={!matching.interaction}>
              <summary><span className="inspector-card-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M2 1.5v11l3.5-3 2.3 4 2-1-2.3-4L12 8z" /></svg></span><span>交互</span><small>SDK View 标志</small></summary>
              <div className="inspector-card-body">
                <dl className="inspector-property-list">
                  <div><dt>可点击</dt><dd>{node.clickable ? "是" : "否"}</dd></div>
                  {sdkInteractions.map(([label, key]) => {
                    const flag = node.attributes?.[key];
                    return <div key={key}><dt>{label}</dt><dd>{flag === "true" ? "是" : flag === "false" ? "否" : "—"}</dd></div>;
                  })}
                </dl>
                <p className="inspector-image-note">点击监听器仅指标准 OnClickListener；“否”不代表控件或子项不能响应手势。</p>
              </div>
            </details>}
            <details className="inspector-card inspector-image" open hidden={!matching.image}>
              <summary><span className="inspector-card-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="2" y="3" width="12" height="10" rx="1" /><path d="m3 11 3-3 2 2 2-4 3 5" /></svg></span><span>画面</span></summary>
              <div className="inspector-card-body">
                <div className="inspector-image-state" data-state={node.layerImageStatus} data-empty={node.layerImageEmpty}><span>{node.layerImageStatus === "style" ? "绘制方式" : "独立画面"}</span><strong>{imageLabel}</strong></div>
                <p className="inspector-image-note">{imageStatus}</p>
                {node.attributes?.["image-capture-error"] && <p className="inspector-image-note">原因：{node.attributes["image-capture-error"]}</p>}
                {node.attributes?.["image-refresh-error"] && <p className="inspector-image-note">上次刷新失败，保留旧画面：{node.attributes["image-refresh-error"]}</p>}
                {node.attributes?.["image-source"] && <p className="inspector-image-note">来源：{node.attributes["image-source"]}</p>}
                {onReadStyle && <button className="inspector-style-read" type="button" disabled={styleBusy} onClick={() => void readStyle()}>{styleBusy ? "正在读取样式…" : "读取实时样式"}</button>}
                {onRefresh && <button className="inspector-image-refresh" type="button" disabled={refreshBusy} onClick={onRefresh}>{refreshBusy ? "正在刷新…" : "刷新当前控件"}</button>}
                {onRefreshBranch && <button className="inspector-image-refresh" type="button" disabled={refreshBusy} onClick={onRefreshBranch}>{refreshBusy ? "正在刷新…" : "刷新此分支"}</button>}
                {styleError && <p className="inspector-image-note" role="status">{styleError}</p>}
                {shownStyle && <>
                  <p className="inspector-image-note">Debug SDK 实时读取 · {new Date(shownStyle.capturedAtMillis).toLocaleString()} · 不修改快照</p>
                  <dl className="inspector-property-list">
                    <div><dt>背景类型</dt><dd>{shownStyle.backgroundType ?? "无背景"}</dd></div>
                    <div><dt>背景源色</dt><dd>{shownStyle.backgroundColor ?? (shownStyle.backgroundType ? "非单一纯色或未暴露" : "—")}</dd></div>
                    {shownStyle.textColor && <div><dt>当前文字色</dt><dd>{shownStyle.textColor}</dd></div>}
                    {shownStyle.textSizePx !== null && <div><dt>文字大小</dt><dd>{Math.round(shownStyle.textSizePx * 100) / 100}px</dd></div>}
                  </dl>
                </>}
                {refreshStatus && <p className="inspector-image-note" role="status">{refreshStatus}</p>}
                <dl className="inspector-inline-values">
                  <div><dt>设备可见</dt><dd>{node.visibleToUser ? "是" : "否"}</dd></div>
                  <div><dt>可点击</dt><dd>{node.clickable ? "是" : "否"}</dd></div>
                </dl>
                {(node.attributes?.["image-source"] || node.attributes?.["image-capture-error"] || node.layerImageStatus === "style") && <details className="inspector-subsection">
                  <summary>采集与样式详情</summary>
                  <dl className="inspector-property-list">
                    {node.attributes?.["image-source"] && <div><dt>画面来源</dt><dd>{node.attributes["image-source"]}</dd></div>}
                    {node.attributes?.["image-refreshed-at"] && <div><dt>刷新时间</dt><dd>{new Date(node.attributes["image-refreshed-at"]).toLocaleString()}</dd></div>}
                    {node.attributes?.["image-capture-error"] && <div><dt>补采说明</dt><dd>{node.attributes["image-capture-error"]}</dd></div>}
                    {node.layerImageStatus === "style" && <>
                      <div><dt>背景色</dt><dd>{valueOrDash(node.attributes?.["background-color"])}</dd></div>
                      <div><dt>边框色</dt><dd>{valueOrDash(node.attributes?.["border-color"])}</dd></div>
                      <div><dt>边框状态</dt><dd>{valueOrDash(node.attributes?.["border-status"])}</dd></div>
                      <div><dt>圆角</dt><dd>{node.attributes?.["corner-radii"] ? `${node.attributes["corner-radii"]}px` : "—"}</dd></div>
                    </>}
                  </dl>
                </details>}
              </div>
            </details>
            <details className="inspector-card inspector-more" hidden={!matching.raw}>
              <summary><span className="inspector-card-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M4 1.5h5l3 3v10H4zM8 2v4h4M6 9h4M6 11h4" /></svg></span><span>原始属性与定位</span></summary>
              <div className="inspector-card-body">
                <p className="node-id">#{node.id}</p>
                <dl className="inspector-property-list"><div><dt>flags</dt><dd>{flags}</dd></div></dl>
                {children}
              </div>
            </details>
          </div>
          {!Object.values(matching).some(Boolean) && <p className="inspector-search-empty" role="status">没有匹配的属性分组</p>}
        </div>
      </aside>
    </>
  );
}
