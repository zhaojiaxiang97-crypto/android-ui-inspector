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

// Keep the whole panel reachable, including after window/content size changes.
function placeInspector(panel: HTMLElement, x: number, y: number) {
  const workspace = panel.parentElement;
  if (!workspace) return;
  panel.style.left = `${Math.max(12, Math.min(x, workspace.clientWidth - panel.offsetWidth - 12))}px`;
  panel.style.right = "auto";
  panel.style.setProperty("--inspector-top", `${Math.max(12, Math.min(y, workspace.clientHeight - panel.offsetHeight - 12))}px`);
}

export function NodePropertiesPanel({ root, node, screenshotSize, toolbarHost, onCopy, copyStatus, children }: Props) {
  const [visible, setVisible] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const panelId = useId();
  useEffect(() => {
    const panel = panelRef.current;
    const workspace = panel?.parentElement;
    if (!visible || !panel || !workspace) return;
    const observer = new ResizeObserver(() => {
      if (panel.style.left) placeInspector(panel, panel.offsetLeft, panel.offsetTop);
    });
    observer.observe(panel);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [visible]);

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
  const source = node.attributes?.["inspection-source"] === "debug-qml" ? "QML Debug" : "View Debug";
  const imageStatus = node.layerImageStatus ? {
    captured: node.layerImageEmpty === true ? "采集画面全透明，仅显示边框" : node.layerImageEmpty === false ? "已采集独立画面，含可见像素" : "已采集独立画面（透明度未检测）",
    style: "QML 真实样式重建（非独立截图）",
    unavailable: node.attributes?.["skip-draw"] === "true" ? "结构容器，系统跳过自身绘制" : "未返回独立位图，不代表控件透明",
    ambiguous: "匹配有歧义，未使用位图",
    hidden: "控件或祖先不可见",
    failed: "独立画面采集失败",
  }[node.layerImageStatus] : "当前数据无独立位图状态";

  return (
    <>
      {toolbarHost && createPortal(
        <button ref={toggleRef} className="inspector-toggle" type="button" aria-label="显示或隐藏属性面板" title="属性面板" aria-expanded={visible} aria-controls={panelId}
          onClick={() => { setVisible(!visible); setCollapsed(false); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16M18 8h1M18 12h1" /></svg>
        </button>, toolbarHost)}
      <aside id={panelId} ref={panelRef} className={`floating-inspector ${collapsed ? "is-collapsed" : ""}`} hidden={!visible} data-node-id={node.id} aria-label="节点属性"
        onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closePanel(); } }}>
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
          <div className="inspector-node-heading">
            <div>
              <h4 title={displayName}>{displayName}</h4>
              <p className="inspector-node-type" title={[node.className, node.resourceId || `#${node.id}`].filter(Boolean).join("\n")}>
                {nodeShortClass(node)} · {node.resourceId?.replace(/^.*:id\//, "@id/") || `#${node.id}`}
              </p>
              <p className="inspector-node-parent" title={parent ? `${parentName}\n${parent.className ?? ""}\n#${parent.id}` : parentName}>父容器 · <span>{parentName}</span></p>
            </div>
            <button className="inspector-copy" type="button" aria-label="复制节点 JSON" title="复制节点 JSON" onClick={onCopy}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="5" y="5" width="8" height="8" rx="1" /><path d="M10 3H3v7" /></svg>
            </button>
          </div>
          {copyStatus && <p className="inspector-copy-status" role="status">{copyStatus}</p>}
          <section className="inspector-geometry" aria-label="位置与尺寸">
            <h5>位置与尺寸 <span>px</span></h5>
            <dl>{[["X", rect?.left], ["Y", rect?.top], ["W", rect?.width], ["H", rect?.height]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{valueOrDash(value)}</dd></div>)}</dl>
          </section>
          <dl className="inspector-summary">
            <div><dt>画面</dt><dd title={imageStatus}>{imageStatus}</dd></div>
            <div><dt>设备可见</dt><dd>{node.visibleToUser ? "是" : "否"}</dd><dt>可点击</dt><dd>{node.clickable ? "是" : "否"}</dd></div>
          </dl>
          <details className="inspector-more">
            <summary>更多属性</summary>
            <p className="node-id">#{node.id}</p>
            <div className="node-properties-panel">
      <section className="node-property-section" aria-labelledby="node-common-properties">
        <div className="node-property-heading">
          <h5 id="node-common-properties">常用属性</h5>
          <span>{source}</span>
        </div>
        <dl className="node-property-grid">
          <div><dt>class</dt><dd title={node.className ?? undefined}>{valueOrDash(node.className)}</dd></div>
          <div><dt>图层画面</dt><dd title={imageStatus}>{imageStatus}</dd></div>
          {node.attributes?.["image-source"] && <div><dt>画面来源</dt><dd>{node.attributes["image-source"]}</dd></div>}
          {node.attributes?.["image-capture-error"] && <div><dt>补采说明</dt><dd title={node.attributes["image-capture-error"]}>{node.attributes["image-capture-error"]}</dd></div>}
          {node.layerImageStatus === "style" && <>
            <div><dt>背景色</dt><dd>{valueOrDash(node.attributes?.["background-color"])}</dd></div>
            <div><dt>边框色</dt><dd>{valueOrDash(node.attributes?.["border-color"])}</dd></div>
            <div><dt>边框宽</dt><dd>{px(Number(node.attributes?.["border-width"]))}</dd></div>
            <div><dt>边框状态</dt><dd title={node.attributes?.["border-status"]}>{valueOrDash(node.attributes?.["border-status"])}</dd></div>
            <div><dt>圆角</dt><dd>{valueOrDash(node.attributes?.["corner-radii"])}px</dd></div>
          </>}
          <div><dt>index</dt><dd>{valueOrDash(node.index)}</dd></div>
          <div><dt>package</dt><dd title={node.package ?? undefined}>{valueOrDash(node.package)}</dd></div>
          <div><dt>text</dt><dd title={node.text ?? undefined}>{valueOrDash(node.text)}</dd></div>
          <div><dt>content-desc</dt><dd title={node.contentDesc ?? undefined}>{valueOrDash(node.contentDesc)}</dd></div>
          <div><dt>resource-id</dt><dd title={node.resourceId ?? undefined}>{valueOrDash(node.resourceId)}</dd></div>
          <div><dt>flags</dt><dd title={flags}>{flags}</dd></div>
          <div><dt>children</dt><dd>{metrics.childCount}</dd></div>
          <div><dt>depth</dt><dd>{metrics.depth}</dd></div>
          <div><dt>label</dt><dd title={nodeDisplayLabel(node)}>{nodeDisplayLabel(node)}</dd></div>
        </dl>
      </section>

      <section className="node-property-section" aria-labelledby="node-geometry-properties">
        <div className="node-property-heading">
          <h5 id="node-geometry-properties">几何尺寸</h5>
          <span>{rect ? "bounds 实测 · screen px" : "无有效 bounds"}</span>
        </div>
        {rect ? (
          <dl className="node-property-grid geometry-grid">
            <div><dt>X / Y</dt><dd>{px(rect.left)} / {px(rect.top)}</dd></div>
            <div><dt>宽 / 高</dt><dd>{px(rect.width)} / {px(rect.height)}</dd></div>
            <div><dt>右 / 下</dt><dd>{px(rect.right)} / {px(rect.bottom)}</dd></div>
            <div><dt>中心点</dt><dd>{px(rect.centerX)} / {px(rect.centerY)}</dd></div>
            <div><dt>面积</dt><dd>{Math.round(rect.area).toLocaleString("zh-CN")} px²</dd></div>
            <div><dt>Z / 深度</dt><dd>{node.attributes?.z !== undefined ? `Z ${node.attributes.z}` : "无实测 Z"} · hierarchy depth {metrics.depth}</dd></div>
            <div><dt>bounds</dt><dd title={node.bounds?.raw}>{node.bounds?.raw ?? "—"}</dd></div>
            {parentOffset && <div><dt>父级内偏移</dt><dd>X {px(parentOffset.x)} · Y {px(parentOffset.y)}</dd></div>}
            {screenshotSize && <div><dt>截图尺寸</dt><dd>{screenshotSize.width} × {screenshotSize.height}px</dd></div>}
          </dl>
        ) : (
          <p className="node-property-empty">当前节点没有可计算的有效 bounds，无法计算坐标和宽高。</p>
        )}
      </section>

      <section className="node-property-section" aria-labelledby="node-box-model">
        <div className="node-property-heading">
          <h5 id="node-box-model">布局盒模型</h5>
          <span>示意 · 非比例</span>
        </div>
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
            </div>
            {children}
          </details>
        </div>
      </aside>
    </>
  );
}
