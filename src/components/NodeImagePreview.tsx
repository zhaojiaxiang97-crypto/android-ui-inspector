import { AppIcon } from "./AppIcon";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { PreparedNodeImagePreview } from "../features/layers/prepareNodeImagePreview";
import { EntryDialog } from "./EntryDialog";
import "../styles/node-image-preview.css";

export type NodeImagePreviewState = {
  title: string; source: string; detail: string; sourceKind: "own" | "group" | "composite";
  image: PreparedNodeImagePreview | null; error: string | null;
};
type PreviewOutput = { busy: boolean; status: string | null; supported: boolean; run: (action: "copy" | "save") => void };
type ReadingAnchor = { x: number; y: number; viewportX: number; viewportY: number };
type Pan = { pointerId: number; x: number; y: number; scrollLeft: number; scrollTop: number };
const clampScale = (value: number) => Math.max(.01, Math.min(8, Math.round(value * 1000) / 1000));

export function NodeImagePreview({ state, onClose, output }: { state: NodeImagePreviewState; onClose: () => void; output?: PreviewOutput }) {
  const headingId = useId(), viewport = useRef<HTMLDivElement>(null), bitmap = useRef<HTMLImageElement>(null);
  const [area, setArea] = useState({ width: 0, height: 0 }), [zoom, setZoom] = useState<number | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false), [panning, setPanning] = useState(false);
  const anchor = useRef<ReadingAnchor | null>(null), previousImage = useRef(state.image);
  const pan = useRef<Pan | null>(null), composing = useRef(false);
  const image = state.image;
  const scale = image ? zoom ?? Math.min(1, Math.max(1, area.width - 32) / image.size.width, Math.max(1, area.height - 32) / image.size.height) : 1;
  const endPan = () => {
    const current = pan.current; pan.current = null; setPanning(false);
    if (current && viewport.current?.hasPointerCapture(current.pointerId)) viewport.current.releasePointerCapture(current.pointerId);
  };
  const clearGesture = () => { endPan(); setSpaceHeld(false); composing.current = false; };
  const keepReadingPoint = (clientX?: number, clientY?: number) => {
    const element = viewport.current, picture = bitmap.current;
    if (!element || !picture) return;
    const frame = element.getBoundingClientRect(), rect = picture.getBoundingClientRect();
    const x = clientX ?? frame.left + element.clientLeft + element.clientWidth / 2;
    const y = clientY ?? frame.top + element.clientTop + element.clientHeight / 2;
    anchor.current = { x: (x - rect.left) / scale, y: (y - rect.top) / scale,
      viewportX: x - frame.left - element.clientLeft, viewportY: y - frame.top - element.clientTop };
  };
  const changeZoom = (value: number | null, clientX?: number, clientY?: number) => {
    if (!image || (value !== null && clampScale(value) === scale && zoom !== null) || (value === null && zoom === null)) return;
    endPan(); keepReadingPoint(clientX, clientY); setZoom(value === null ? null : clampScale(value));
  };
  const zoomAt = useRef(changeZoom); zoomAt.current = changeZoom;
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setArea({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = viewport.current, picture = bitmap.current;
    if (previousImage.current !== image) {
      previousImage.current = image; anchor.current = null; clearGesture(); setZoom(null); element?.scrollTo(0, 0); return;
    }
    const point = anchor.current; anchor.current = null;
    if (!point || !element || !picture) return;
    const frame = element.getBoundingClientRect(), rect = picture.getBoundingClientRect();
    element.scrollTo(rect.left - frame.left - element.clientLeft + element.scrollLeft + point.x * scale - point.viewportX,
      rect.top - frame.top - element.clientTop + element.scrollTop + point.y * scale - point.viewportY);
  }, [image, scale, area.width, area.height]);
  useLayoutEffect(() => {
    const element = bitmap.current;
    return () => { element?.removeAttribute("src"); };
  }, [image?.dataUrl]);
  useEffect(() => {
    const element = viewport.current!;
    const wheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || composing.current || !bitmap.current) return;
      event.preventDefault(); event.stopPropagation();
      zoomAt.current(scaleRef.current * Math.exp(-event.deltaY * .002), event.clientX, event.clientY);
    };
    const releaseSpace = (event: globalThis.KeyboardEvent) => { if (event.code === "Space" || event.key === " ") setSpaceHeld(false); };
    element.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("blur", clearGesture); window.addEventListener("keyup", releaseSpace);
    return () => { element.removeEventListener("wheel", wheel); window.removeEventListener("blur", clearGesture); window.removeEventListener("keyup", releaseSpace); };
  }, []);
  const scaleRef = useRef(scale); scaleRef.current = scale;
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!image || event.target !== event.currentTarget || event.nativeEvent.isComposing || event.keyCode === 229 || composing.current || event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === " ") { event.preventDefault(); setSpaceHeld(true); return; }
    const key = event.key;
    if (!["+", "=", "-", "_", "0", "1"].includes(key)) return;
    event.preventDefault(); event.stopPropagation();
    changeZoom(key === "0" ? null : key === "1" ? 1 : scale * (key === "+" || key === "=" ? 1.25 : 1 / 1.25));
  };
  const startPan = (event: PointerEvent<HTMLDivElement>) => {
    if (!image || composing.current || (event.button !== 1 && !(event.button === 0 && spaceHeld))) return;
    event.preventDefault(); event.stopPropagation();
    const element = event.currentTarget; element.focus({ preventScroll: true }); endPan();
    pan.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, scrollLeft: element.scrollLeft, scrollTop: element.scrollTop };
    element.setPointerCapture(event.pointerId); setPanning(true);
  };
  const movePan = (event: PointerEvent<HTMLDivElement>) => {
    const current = pan.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.scrollLeft = current.scrollLeft + current.x - event.clientX;
    event.currentTarget.scrollTop = current.scrollTop + current.y - event.clientY;
  };
  return <EntryDialog className="node-image-preview" labelledBy={headingId} onClose={onClose}>
    <div className="node-image-preview-content" data-preview-mode={zoom === null ? "fit" : zoom === 1 ? "pixels" : "custom"}
      data-preview-zoom={scale} onPointerDown={event => event.stopPropagation()}
      onPointerUp={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
      <div className="entry-dialog-heading">
        <h2 id={headingId}>控件图片预览</h2>
        <button type="button" className="entry-dialog-close" aria-label="关闭控件图片预览" onClick={onClose} autoFocus><AppIcon name="close" size={14} /></button>
      </div>
      <p className="node-image-preview-name" title={state.title}>{state.title}</p>
      <div className="node-image-preview-meta">
        <strong data-image-source={state.sourceKind}>{state.source}</strong>
        <span className="node-image-preview-size">{image ? `${image.size.width} × ${image.size.height} px` : state.error ? "图片不可用" : "正在准备图片…"}</span>
      </div>
      <div className="node-image-preview-tools" role="group" aria-label="图片工具">
        <button type="button" className="node-image-preview-fit" disabled={!image} aria-pressed={zoom === null} onClick={() => changeZoom(null)}>适应</button>
        <button type="button" className="node-image-preview-pixels" disabled={!image} aria-pressed={zoom === 1} onClick={() => changeZoom(1)}>100%</button>
        <button type="button" disabled={!image || scale <= .01} aria-label="缩小预览图片" onClick={() => changeZoom(scale / 1.25)}><AppIcon name="minus" size={14} /></button>
        <output aria-label="预览图片缩放比例">{image ? `${Math.round(scale * 100)}%` : "—"}</output>
        <button type="button" disabled={!image || scale >= 8} aria-label="放大预览图片" onClick={() => changeZoom(scale * 1.25)}><AppIcon name="plus" size={14} /></button>
        <button type="button" className="node-image-preview-copy" disabled={!image || Boolean(state.error) || !output?.supported || output.busy} onClick={() => output?.run("copy")}>复制图片</button>
        <button type="button" className="node-image-preview-save" disabled={!image || Boolean(state.error) || !output?.supported || output.busy} onClick={() => output?.run("save")}>导出 PNG</button>
        <span>棋盘格表示透明区域</span>
      </div>
      <div ref={viewport} className="node-image-preview-viewport" tabIndex={image ? 0 : -1} aria-label="控件图片，可滚动查看"
        data-preview-gesture={panning ? "pan" : spaceHeld ? "ready" : undefined}
        onKeyDown={keyDown} onKeyUp={event => { if (event.key === " ") setSpaceHeld(false); }} onBlur={clearGesture}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={clearGesture} onLostPointerCapture={endPan}>
        {image ? <div className="node-image-preview-scroll-content" style={{ width: Math.max(area.width, image.size.width * scale + 32), height: Math.max(area.height, image.size.height * scale + 32) }}>
          <img key={image.dataUrl} ref={bitmap} className="node-image-preview-image" src={image.dataUrl} alt={`${state.title} · ${state.source}`} draggable={false}
            data-image-width={image.size.width} data-image-height={image.size.height}
            width={image.size.width} height={image.size.height} style={{ width: image.size.width * scale, height: image.size.height * scale }} />
        </div> : <p className={`node-image-preview-message${state.error ? " is-error" : ""}`} role={state.error ? "alert" : "status"}>{state.error || "正在准备已保存的图片…"}</p>}
      </div>
      <p className="node-image-preview-output-status" role="status" aria-live="polite">{output?.status || (!output?.supported ? "当前环境不支持保存或复制。" : "\u00a0")}</p>
      <p className="node-image-preview-hints">空格 / 中键拖动 · Cmd/Ctrl + 滚轮缩放 · 预览区：+ / −、0 适应、1 原尺寸。<br />100%：1 图像像素 = 1 CSS 像素；页面缩放与屏幕 DPI 另计。</p>
      <p className="node-image-preview-detail">{state.detail}</p>
    </div>
  </EntryDialog>;
}
