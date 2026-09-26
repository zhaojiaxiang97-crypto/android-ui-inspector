import { useEffect, useId, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PixelSize, UiNode } from "../../shared/types";
import { nodeMetrics } from "../../shared/node-metrics";
import { nodeDisplayLabel, nodeShortClass } from "../../shared/tree-utils";

type Props = {
  root: UiNode;
  node: UiNode;
  screenshotSize: PixelSize | null;
  toolbarHost: HTMLElement | null;
  onCopy: () => void;
  copyStatus: string | null;
  children: ReactNode;
};

function valueOrDash(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function px(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : `${Math.round(value * 100) / 100}px`;
}

// Let a tall inspector shrink its scroll area while moving; keep its header reachable.
function placeInspector(panel: HTMLElement, x: number, y: number) {
  const workspace = panel.parentElement;
  if (!workspace) return;
  const viewportHeight = Number.parseFloat(panel.style.getPropertyValue("--inspector-viewport-height")) || workspace.clientHeight;
  panel.style.left = `${Math.max(12, Math.min(x, workspace.clientWidth - panel.offsetWidth - 12))}px`;
  panel.style.right = "auto";
  panel.style.setProperty("--inspector-top", `${Math.max(12, Math.min(y, viewportHeight - Math.min(panel.offsetHeight, 160) - 16))}px`);
}

export function NodePropertiesPanel({ root, node, screenshotSize, toolbarHost, onCopy, copyStatus, children }: Props) {
  const [visible, setVisible] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [search, setSearch] = useState("");
  const panelRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const panelId = useId();
  useEffect(() => {
    const panel = panelRef.current;
    const workspace = panel?.parentElement;
    if (!visible || !panel || !workspace) return;
    const canvas = workspace.querySelector<HTMLElement>(".screenshot-frame");
    const observer = new ResizeObserver(() => {
      const height = Math.min(workspace.clientHeight, canvas ? canvas.offsetTop + canvas.offsetHeight : workspace.clientHeight);
      panel.style.setProperty("--inspector-viewport-height", `${height}px`);
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
  const displayName = nodeDisplayLabel(node);
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
  const source = sourceValue === "debug-qml" ? "QML Debug" : sourceValue === "debug-view" ? "View Debug" : sourceValue || "来源未标注";
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
    type: matches("类型 class 资源 ID resource-id 文本 text content-desc 描述 package 包名", source, node.className, node.resourceId, node.package, node.text, node.contentDesc),
    relation: matches("关系 relation 父容器 parent 子节点 children 层级 depth index 序号", parentName, parent?.className, parent?.id, metrics.childCount, metrics.depth, node.index),
    layout: matches("布局 layout 位置 尺寸 geometry bounds 屏幕 px X Y W H width height 右 下 中心 面积 Z 父级内偏移 截图 padding 内边距 margin 外边距 border 边框", node.bounds?.raw, JSON.stringify(rect), JSON.stringify(padding), borderWidth, node.attributes?.z),
    image: matches("画面 image 设备可见 visible 可点击 clickable 背景色 background-color 边框色 border-color 圆角 corner-radii", imageStatus, imageLabel, node.visibleToUser ? "是" : "否", node.clickable ? "是" : "否", ...["image-source", "image-capture-error", "background-color", "border-color", "corner-radii"].map(key => node.attributes?.[key])),
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
                  <div><dt>资源 ID</dt><dd title={node.resourceId ?? undefined}>{valueOrDash(node.resourceId?.replace(/^.*:id\//, "@id/"))}</dd></div>
                </dl>
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
                <details className="inspector-subsection">
                  <summary>更多几何信息</summary>
                  <dl className="inspector-property-list">
                    <div><dt>右 / 下</dt><dd>{px(rect?.right)} / {px(rect?.bottom)}</dd></div>
                    <div><dt>中心点</dt><dd>{px(rect?.centerX)} / {px(rect?.centerY)}</dd></div>
                    <div><dt>面积</dt><dd>{rect ? `${Math.round(rect.area).toLocaleString("zh-CN")} px²` : "—"}</dd></div>
                    <div><dt>原生 Z</dt><dd>{valueOrDash(node.attributes?.z)}</dd></div>
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
                        <div><dt>margin</dt><dd title="外边距未采集">—</dd></div>
                        <div><dt>border</dt><dd title={node.attributes?.["border-status"] ?? "边框宽度未采集"}>{px(borderWidth)}</dd></div>
                      </dl>
                    </div>
                    <p className="box-model-note">— 表示未采集，不是 0。内容尺寸不由外框推算。</p>
                  </section>
                </details>
              </div>
            </details>
            <details className="inspector-card inspector-image" open hidden={!matching.image}>
              <summary><span className="inspector-card-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="2" y="3" width="12" height="10" rx="1" /><path d="m3 11 3-3 2 2 2-4 3 5" /></svg></span><span>画面</span></summary>
              <div className="inspector-card-body">
                <div className="inspector-image-state" data-state={node.layerImageStatus} data-empty={node.layerImageEmpty}><span>{node.layerImageStatus === "style" ? "绘制方式" : "独立画面"}</span><strong>{imageLabel}</strong></div>
                <p className="inspector-image-note">{imageStatus}</p>
                <dl className="inspector-inline-values">
                  <div><dt>设备可见</dt><dd>{node.visibleToUser ? "是" : "否"}</dd></div>
                  <div><dt>可点击</dt><dd>{node.clickable ? "是" : "否"}</dd></div>
                </dl>
                {(node.attributes?.["image-source"] || node.attributes?.["image-capture-error"] || node.layerImageStatus === "style") && <details className="inspector-subsection">
                  <summary>采集与样式详情</summary>
                  <dl className="inspector-property-list">
                    {node.attributes?.["image-source"] && <div><dt>画面来源</dt><dd>{node.attributes["image-source"]}</dd></div>}
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
