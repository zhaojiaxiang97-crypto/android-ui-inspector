import { useRef, useState, type PointerEvent } from "react";
import type { CaptureGeometry, PixelSize, UiNode } from "../../shared/types";
import { assessCaptureGeometry, boundsPercent, clientToScreen, findNodeAtPoint, validSize } from "../../shared/screen-coordinates";

type Props = { src: string; root: UiNode; selectedNode: UiNode | null; geometry?: CaptureGeometry; onSelect: (node: UiNode) => void };

export function ScreenshotPreview(props: Props) {
  // Changing snapshots cannot reuse the preceding image's dimensions or events.
  return <LoadedScreenshot key={props.src} {...props} />;
}

function LoadedScreenshot({ src, root, selectedNode, geometry, onSelect }: Props) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState<PixelSize | null>(null);
  const [failed, setFailed] = useState(false);
  const integrity = assessCaptureGeometry(geometry, size ?? undefined);
  const enabled = Boolean(size && !failed && integrity.status !== "mismatch");
  const overlay = enabled && size && selectedNode?.visibleToUser && selectedNode.bounds ? boundsPercent(selectedNode.bounds, size) : null;

  function selectAtPoint(event: PointerEvent<HTMLDivElement>) {
    const image = imageRef.current;
    if (event.button !== 0 || !event.isPrimary || !enabled || !size || !image || !image.complete || !image.naturalWidth) return;
    const point = clientToScreen(event.clientX, event.clientY, image.getBoundingClientRect(), size);
    const node = point ? findNodeAtPoint(root, point.x, point.y, size) : null;
    if (node) onSelect(node);
  }

  return <>
    <div className="screenshot-frame">
      <div className="screenshot-stage" data-coordinate-status={enabled ? integrity.status : failed ? "error" : size ? integrity.status : "loading"}
        style={{ width: size ? `min(100%, ${Math.min(size.width, 400 * size.width / size.height)}px)` : 0, aspectRatio: size ? `${size.width} / ${size.height}` : undefined }}
        // Pointer-up retains fractional CSS pixels. Compatibility click events
        // truncate clientX/Y and can choose the wrong side of a shared edge.
        onPointerUp={selectAtPoint}>
        <img ref={imageRef} src={src} alt="Android screen snapshot" draggable={false}
          onLoad={event => {
            const image = event.currentTarget;
            const next = { width: image.naturalWidth, height: image.naturalHeight };
            if (validSize(next)) { setSize(next); setFailed(false); }
            else { setSize(null); setFailed(true); }
          }}
          onError={() => { setSize(null); setFailed(true); }} />
        {overlay && <div className="selection-overlay" style={overlay} aria-hidden="true" />}
      </div>
      {!size && <div className="no-screenshot" role="status">{failed ? "截图无法解码，请重新获取；节点树仍可使用。" : "正在加载截图…"}</div>}
    </div>
    {size && <p className={`screenshot-status ${integrity.status}`} role="status">
      {size.width}×{size.height} · {size.width > size.height ? "横屏" : size.width < size.height ? "竖屏" : "方形"} · {integrity.message}
    </p>}
    {enabled && <p className="screenshot-hint">点击截图可定位节点，并清除筛选、展开祖先和滚动到目标行；这不会点击手机。</p>}
  </>;
}
