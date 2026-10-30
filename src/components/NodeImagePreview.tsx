import { useId, useLayoutEffect, useRef, useState } from "react";
import type { PreparedNodeImagePreview } from "../features/layers/prepareNodeImagePreview";
import { EntryDialog } from "./EntryDialog";
import "../styles/node-image-preview.css";

export type NodeImagePreviewState = {
  title: string; source: string; detail: string; sourceKind: "own" | "group" | "composite";
  image: PreparedNodeImagePreview | null; error: string | null;
};

export function NodeImagePreview({ state, onClose }: { state: NodeImagePreviewState; onClose: () => void }) {
  const headingId = useId(), viewport = useRef<HTMLDivElement>(null), bitmap = useRef<HTMLImageElement>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setArea({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => { if (viewport.current) viewport.current.scrollTo(0, 0); }, [state.image, zoom]);
  useLayoutEffect(() => {
    const element = bitmap.current;
    return () => { element?.removeAttribute("src"); };
  }, [state.image]);
  const image = state.image;
  const scale = image ? zoom ?? Math.min(1, Math.max(1, area.width - 32) / image.size.width, Math.max(1, area.height - 32) / image.size.height) : 1;
  const changeZoom = (factor: number) => setZoom(Math.max(.01, Math.min(8, Math.round(scale * factor * 1000) / 1000)));
  return <EntryDialog className="node-image-preview" labelledBy={headingId} onClose={onClose}>
    <div className="node-image-preview-content" data-preview-mode={zoom === null ? "fit" : zoom === 1 ? "pixels" : "custom"}
      data-preview-zoom={scale} onPointerDown={event => event.stopPropagation()}
      onPointerUp={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
      <div className="entry-dialog-heading">
        <h2 id={headingId}>控件图片预览</h2>
        <button type="button" className="entry-dialog-close" aria-label="关闭控件图片预览" onClick={onClose} autoFocus>×</button>
      </div>
      <p className="node-image-preview-name" title={state.title}>{state.title}</p>
      <div className="node-image-preview-meta">
        <strong data-image-source={state.sourceKind}>{state.source}</strong>
        <span className="node-image-preview-size">{image ? `${image.size.width} × ${image.size.height} px` : state.error ? "图片不可用" : "正在准备图片…"}</span>
      </div>
      <div className="node-image-preview-tools" role="group" aria-label="图片缩放">
        <button type="button" className="node-image-preview-fit" disabled={!image} aria-pressed={zoom === null} onClick={() => setZoom(null)}>适应</button>
        <button type="button" className="node-image-preview-pixels" disabled={!image} aria-pressed={zoom === 1} onClick={() => setZoom(1)}>100%</button>
        <button type="button" disabled={!image || scale <= .01} aria-label="缩小预览图片" onClick={() => changeZoom(1 / 1.25)}>−</button>
        <output aria-label="预览图片缩放比例">{image ? `${Math.round(scale * 100)}%` : "—"}</output>
        <button type="button" disabled={!image || scale >= 8} aria-label="放大预览图片" onClick={() => changeZoom(1.25)}>+</button>
        <span>棋盘格表示透明区域</span>
      </div>
      <div ref={viewport} className="node-image-preview-viewport" tabIndex={image ? 0 : -1} aria-label="控件图片，可滚动查看">
        {image ? <div className="node-image-preview-scroll-content" style={{ width: Math.max(area.width, image.size.width * scale + 32), height: Math.max(area.height, image.size.height * scale + 32) }}>
          <img ref={bitmap} className="node-image-preview-image" src={image.dataUrl} alt={`${state.title} · ${state.source}`} draggable={false}
            data-image-width={image.size.width} data-image-height={image.size.height}
            width={image.size.width} height={image.size.height} style={{ width: image.size.width * scale, height: image.size.height * scale }} />
        </div> : <p className={`node-image-preview-message${state.error ? " is-error" : ""}`} role={state.error ? "alert" : "status"}>{state.error || "正在准备已保存的图片…"}</p>}
      </div>
      <p className="node-image-preview-detail">{state.detail}</p>
    </div>
  </EntryDialog>;
}
