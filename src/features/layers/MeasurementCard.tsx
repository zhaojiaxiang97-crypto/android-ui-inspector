import { AppIcon } from "../../components/AppIcon";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { measurementCardDiagram, measurementCardNumber, measurementCardPlacement, measurementCardRelationLabel, measurementCardCopyText, type MeasurementSnapshotIdentity } from "../../../shared/measurement-card";
import { nodeImageExportPlan } from "../../../shared/node-image-export";
import { indexTree } from "../../../shared/visible-tree";
import type { QmlGroupImage, SnapshotGroupImage, UiNode } from "../../../shared/types";
import { prepareNodeImageExport } from "./prepareNodeImageExport";
import type { LayerMeasurementState, Rect } from "./types";
import "../../styles/measurement-card.css";

type Props = {
  state: LayerMeasurementState; root: UiNode; savedGroupImages?: readonly SnapshotGroupImage[];
  viewport: Rect; selectionDisabled: boolean; snapshot?: MeasurementSnapshotIdentity;
  onClear: () => void; onPick: (endpoint: "anchor" | "target") => void; onUseSelected: () => void;
  onPin: () => void; onLive: () => void;
};
type PreviewImage = { root: UiNode; node: UiNode | undefined; group: QmlGroupImage | null; url: string | null; label: string; loading: boolean };
const NO_GROUPS: readonly SnapshotGroupImage[] = [];

function useMeasurementImage(root: UiNode, node: UiNode | undefined, group: QmlGroupImage | null) {
  const plan = useMemo(() => node ? nodeImageExportPlan(node, "branch", group) : null, [root, node, group]);
  const [image, setImage] = useState<PreviewImage | null>(null);
  const cache = useRef<PreviewImage[]>([]);
  useEffect(() => { cache.current = []; }, [root]);
  useEffect(() => {
    if (!node || !plan) { setImage(null); return; }
    const cached = cache.current.find(value => value.root === root && value.node === node && value.group === group);
    if (cached) { setImage(cached); return; }
    const identity = { root, node, group };
    if (plan.kind === "unavailable") { setImage({ ...identity, url: null, label: "没有已保存的控件图片，仅测量外框", loading: false }); return; }
    const label = plan.kind === "composite" ? `本地分支图${plan.missingCount ? "（部分缺图）" : ""}` : "已保存分支图";
    const controller = new AbortController();
    setImage({ ...identity, url: null, label: "正在准备控件图片…", loading: true });
    void prepareNodeImageExport(node, plan, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      const value = { ...identity, url: result.dataUrl, label, loading: false };
      cache.current = [...cache.current.filter(entry => entry.node !== node), value].slice(-2);
      setImage(value);
    }).catch(() => { if (!controller.signal.aborted) setImage({ ...identity, url: null, label: "控件图片无法读取，仍可测量外框", loading: false }); });
    return () => controller.abort();
  }, [root, node, group, plan]);
  const current = image?.root === root && image.node === node && image.group === group ? image : null;
  return { ...current, url: current?.url ?? null, label: current?.label ?? "正在准备控件图片…", loading: current?.loading ?? true,
    fail: () => setImage(value => value?.root === root && value.node === node && value.group === group
      ? { ...value, url: null, label: "控件图片无法读取，仍可测量外框", loading: false } : value) };
}

export function MeasurementCard({ state, root, savedGroupImages = NO_GROUPS, viewport, selectionDisabled, snapshot, onClear, onPick, onUseSelected, onPin, onLive }: Props) {
  const headingId = useId();
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const copyRequest = useRef(0);
  useEffect(() => { copyRequest.current++; setCopyStatus(null); return () => { copyRequest.current++; }; }, [root, state.card, snapshot?.id, snapshot?.label, snapshot?.capturedAt]);
  async function copyResult() {
    if (!state.card) return;
    const request = ++copyRequest.current;
    try {
      await window.electronApi.copyText(measurementCardCopyText(state.card, snapshot));
      if (request === copyRequest.current) setCopyStatus("测距结果已复制");
    } catch { if (request === copyRequest.current) setCopyStatus("复制失败，请重试"); }
  }
  const { card: data, picking } = state;
  const nodes = useMemo(() => indexTree(root), [root]);
  const groups = useMemo(() => new Map(savedGroupImages.map(value => [value.nodeId, value.image])), [savedGroupImages]);
  const mainImage = useMeasurementImage(root, data ? nodes.get(data.anchor.id)?.node : undefined, data ? groups.get(data.anchor.id) ?? null : null);
  const referImage = useMeasurementImage(root, data ? nodes.get(data.target.id)?.node : undefined, data ? groups.get(data.target.id) ?? null : null);
  const placement = measurementCardPlacement(viewport);
  if (state.mode === "off" || !placement) return null;
  const preferred = data ? measurementCardDiagram(data, placement.width - 24) : null;
  const diagram = data && preferred ? measurementCardDiagram(data, placement.width - 24, Math.min(preferred.height, Math.max(96, placement.maxHeight - 180))) : null;
  // Anchor to the live frame: pinning changes its height before ResizeObserver
  // publishes the next viewport, especially at fractional display scales.
  const style: CSSProperties = { right: Math.min(12, viewport.width / 4), top: "50%", width: placement.width,
    maxWidth: "calc(100% - 24px)", maxHeight: "calc(100% - 24px)" };
  const anchor = picking?.anchor ?? state.anchor, target = picking ? picking.target : state.target;
  const relation = data?.measurement.relation;
  const mainOpacity = relation === "contains" || relation === "equal" || relation === "overlap" ? .2 : 1;
  const referOpacity = relation === "inside" || relation === "overlap" ? .2 : 1;
  return <section className="measurement-card" style={style} role="region" aria-labelledby={headingId}
    data-measurement-mode={state.mode} data-measurement-anchor={anchor?.id ?? ""} data-measurement-target={target?.id ?? ""} data-measurement-picking={picking?.endpoint ?? ""}
    onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
    onPointerMove={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onKeyDown={event => {
      event.stopPropagation();
      const editing = event.target instanceof HTMLElement && Boolean(event.target.closest("input, textarea, select, [contenteditable=true]"));
      const releaseKey = event.key === "Escape" || (event.key.toLowerCase() === "m" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.repeat);
      if (!editing && releaseKey) { event.preventDefault(); onClear(); }
    }}>
    <header><h3 id={headingId}>测距</h3><span>{state.pinned ? "已固定" : picking ? "选择控件" : "悬停测距"}</span><button type="button" onClick={onClear} aria-label="结束测距" title="结束测距 · Esc"><AppIcon name="close" size={14} /></button></header>
    <div className="measurement-card-pair">
      {(["anchor", "target"] as const).map((which, index) => {
        const value = which === "anchor" ? anchor : target, label = index === 0 ? "起点 A" : "终点 B";
        const active = picking?.endpoint === which;
        return <p className={`measurement-card-${which}${active ? " is-picking" : ""}`} key={which}>
          <b>{index === 0 ? "A" : "B"}</b><span title={value?.label}>{value?.label ?? (index === 0 ? "请选择控件" : "请悬停另一控件")}</span>
          <button type="button" data-measurement-pick={which} aria-label={`${value ? "重新选择" : "选择"}${label}`}
            disabled={active || selectionDisabled} onClick={() => onPick(which)}>{active ? "选择中" : value ? "重选" : "选择"}</button>
        </p>;
      })}
    </div>
    {picking ? <>
      <p className="measurement-picking-hint" role="status">{picking.error ?? `在层级树或画布中点击${picking.endpoint === "anchor" ? "起点 A" : "终点 B"}。`}</p>
      <button className="measurement-use-selected" type="button" disabled={!picking.canUseSelected || selectionDisabled} onClick={onUseSelected}
        title={picking.selectedLabel ?? "请先选择一个可见控件"}>使用当前选中控件</button>
      <p className="measurement-card-units">A 与 B 需为不同控件 · Esc 取消</p>
    </> : data && diagram ? <>
      <svg className="measurement-card-diagram" viewBox={`0 0 ${diagram.width} ${diagram.height}`} role="img"
        aria-label={`A ${data.anchor.label}，B ${data.target.label}，${measurementCardRelationLabel(data)}，按原始外框比例绘制`}>
        {[{ rect: diagram.anchor, image: mainImage, opacity: mainOpacity, name: "anchor" }, { rect: diagram.target, image: referImage, opacity: referOpacity, name: "target" }].map(({ rect, image, opacity, name }) => <g key={name}>
          {image.url ? <image {...rect} href={image.url} opacity={opacity} preserveAspectRatio="none" onError={image.fail} data-measurement-image={name} />
            : <rect className="measurement-image-placeholder" {...rect} />}
        </g>)}
        <rect className="measurement-card-shape" {...diagram.anchor} /><rect className="measurement-card-shape" {...diagram.target} />
        {diagram.dimensions.map(({ from, to, axis, value, labelBox }, index) => {
          const ticks = axis === "horizontal" ? `M ${from.x} ${from.y - 3} v 6 M ${to.x} ${to.y - 3} v 6` : `M ${from.x - 3} ${from.y} h 6 M ${to.x - 3} ${to.y} h 6`;
          return <g key={index} className={`measurement-dimension ${axis}`} data-measurement-axis={axis}>
            <path className="measurement-card-guide" d={`M ${from.x} ${from.y} L ${to.x} ${to.y} ${ticks}`} />
            <g className="measurement-dimension-label"><rect {...labelBox} rx="9" /><text x={labelBox.x + labelBox.width / 2} y={labelBox.y + 12.5} textAnchor="middle">{measurementCardNumber(value)}</text></g>
          </g>;
        })}
      </svg>
      <div className="measurement-card-caption"><span className="horizontal">水平</span><span className="vertical">垂直</span><span>{measurementCardRelationLabel(data)} · px</span></div>
      <dl className="measurement-card-values">{data.dimensions.map(({ label, value, axis }, index) => <div className={axis} key={index}>
        <dt>{label}</dt><dd>{measurementCardNumber(value)} <span>px</span></dd>
      </div>)}</dl>
      {!data.dimensions.length && <p className="measurement-card-zero">四边对齐 · 0 px</p>}
      <p className="measurement-image-note" role="status">A：{mainImage.label}；B：{referImage.label}</p>
      <div className="measurement-result-actions"><button className="measurement-pin" type="button" onClick={state.pinned ? onLive : onPin} disabled={selectionDisabled || !state.pinned && !state.canPin}>
        {state.pinned ? "继续悬停测距" : "固定这对控件"}</button>
        <button className="measurement-copy" type="button" onClick={() => void copyResult()} title="复制 A / B、比较边缘、原始 px 数值和快照来源">复制结果</button></div>
      {copyStatus && <p className="measurement-copy-status" role="status">{copyStatus}</p>}
    </> : <div className="measurement-tutorial" role="status">
      <AppIcon name="compare" size={64} className="measurement-tutorial-icon" />
      <strong>{anchor ? "悬停另一控件" : "先选中一个控件"}</strong>
      <p>{anchor ? `与已选中的 ${anchor.label} 比较距离。` : "在层级树或画布中选中 A，再将鼠标移到 B。"}</p>
      <p>层级树、2D 截图和 3D 画布都可以测距。</p>
    </div>}
    {!picking && <footer className="measurement-card-units">
      {state.mode === "temporary" ? <label><input type="checkbox" checked onChange={onLive} />松开 Option / Alt 结束测距</label>
        : state.pinned ? "已固定控件对 · M / Esc 结束" : "按住 Option / Alt 可临时测距 · Esc 结束"}
    </footer>}
  </section>;
}
