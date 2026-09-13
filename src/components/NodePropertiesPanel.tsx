import { useMemo } from "react";
import type { PixelSize, UiNode } from "../../shared/types";
import { nodeMetrics } from "../../shared/node-metrics";
import { nodeDisplayLabel } from "../../shared/tree-utils";

type Props = {
  root: UiNode;
  node: UiNode;
  screenshotSize: PixelSize | null;
};

function valueOrDash(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function px(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : `${Math.round(value * 100) / 100}px`;
}

export function NodePropertiesPanel({ root, node, screenshotSize }: Props) {
  const metrics = useMemo(() => nodeMetrics(root, node, screenshotSize), [node, root, screenshotSize]);
  const rect = metrics.rect;
  const parentOffset = metrics.parentOffset;
  const flags = [
    node.clickable && "clickable",
    node.enabled && "enabled",
    node.focusable && "focusable",
    node.focused && "focused",
    node.scrollable && "scrollable",
    node.selected && "selected",
    !node.visibleToUser && "hidden",
  ].filter(Boolean).join(" · ") || "none";

  return (
    <div className="node-properties-panel">
      <section className="node-property-section" aria-labelledby="node-common-properties">
        <div className="node-property-heading">
          <h5 id="node-common-properties">常用属性</h5>
          <span>UIAutomator</span>
        </div>
        <dl className="node-property-grid">
          <div><dt>class</dt><dd title={node.className ?? undefined}>{valueOrDash(node.className)}</dd></div>
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
            <div><dt>Z / 深度</dt><dd>无实测 Z · hierarchy depth {metrics.depth}</dd></div>
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
          <span>原生 Android ≠ CSS DOM</span>
        </div>
        <div className={`box-model-card ${rect ? "has-bounds" : "is-unavailable"}`} aria-label="CSS 风格布局盒模型">
          <p className="box-model-source">Android bounds（外部边界）：{rect ? `${Math.round(rect.width)} × ${Math.round(rect.height)}px` : "不可用"}</p>
          <div className="box-model-layer box-model-margin">
            <span className="box-model-layer-name">margin</span>
            <strong>未暴露</strong>
            <div className="box-model-layer box-model-border">
              <span className="box-model-layer-name">border</span>
              <strong>未暴露</strong>
              <div className="box-model-layer box-model-padding">
                <span className="box-model-layer-name">padding</span>
                <strong>未暴露</strong>
                <div className="box-model-layer box-model-content">
                <span className="box-model-layer-name">content</span>
                  <strong>{rect ? "不可从 bounds 拆分" : "不可用"}</strong>
                </div>
              </div>
            </div>
          </div>
        </div>
        <p className="box-model-note">
          {rect
            ? "UIAutomator 只提供控件外部 bounds；padding、border、margin 和真实 content 区域不能从 bounds 推断，因此未填充为 0。"
            : "当前节点没有有效 bounds，盒模型无法计算。"}
        </p>
      </section>
    </div>
  );
}
