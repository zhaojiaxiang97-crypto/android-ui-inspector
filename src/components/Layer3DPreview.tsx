import { useMemo, type CSSProperties, type MouseEvent } from "react";
import type { PixelSize, UiNode } from "../../shared/types";
import { buildLayerLayout, layerPath, type LayerRecord, type LayerScope } from "../../shared/layer-layout";
import { cameraTransform, type OrbitCamera } from "../../shared/orbit-camera";
import { nodeDisplayLabel } from "../../shared/tree-utils";

export type LayerCamera = OrbitCamera;

type Props = {
  src: string;
  root: UiNode;
  selectedNode: UiNode | null;
  size: PixelSize;
  renderScale: number;
  camera: LayerCamera;
  scope: LayerScope;
  includeParents: boolean;
  includeChildren: boolean;
  maxChildDepth: number;
  onSelect: (node: UiNode) => void;
};

type SceneStyle = CSSProperties & {
  "--layer-perspective": string;
  "--layer-camera-transform": string;
};

function planeStyle(src: string, size: PixelSize, renderScale: number, camera: LayerCamera, record: LayerRecord) {
  const left = record.renderBounds.left * renderScale;
  const top = record.renderBounds.top * renderScale;
  const width = (record.renderBounds.right - record.renderBounds.left) * renderScale;
  const height = (record.renderBounds.bottom - record.renderBounds.top) * renderScale;
  return {
    left,
    top,
    width: Math.max(width, 1),
    height: Math.max(height, 1),
    zIndex: record.isSelected ? 500 : 100 + record.depth,
    backgroundImage: `url("${src}")`,
    backgroundSize: `${size.width * renderScale}px ${size.height * renderScale}px`,
    backgroundPosition: `${-left}px ${-top}px`,
    "--layer-z": `${record.z}px`,
    "--layer-opacity": record.isSelected ? 1 : record.isAncestor ? 0.72 : 0.84,
    "--layer-gap": `${camera.layerGap}px`,
  } as CSSProperties & Record<string, string | number>;
}

export function Layer3DPreview({ src, root, selectedNode, size, renderScale, camera, scope, includeParents, includeChildren, maxChildDepth, onSelect }: Props) {
  const layout = useMemo(
    () => buildLayerLayout(root, selectedNode, size, {
      includeParents,
      includeChildren,
      scope,
      maxChildDepth,
      maxDepth: 8,
      maxLayers: 96,
      layerGap: camera.layerGap,
    }),
    [camera.layerGap, includeChildren, includeParents, maxChildDepth, root, scope, selectedNode, size],
  );
  const records = layout.records;
  const breadcrumb = useMemo(() => {
    const { entries, path } = layerPath(root, selectedNode?.id ?? null);
    return path.map((id) => entries.get(id)?.node).filter((node): node is UiNode => Boolean(node));
  }, [root, selectedNode?.id]);

  const sceneStyle: SceneStyle = {
    "--layer-perspective": `${camera.distance}px`,
    "--layer-camera-transform": cameraTransform(camera),
  };

  function selectPlane(event: MouseEvent<HTMLButtonElement>, node: UiNode) {
    event.stopPropagation();
    if (event.button === 0) onSelect(node);
  }

  return (
    <>
      <div className="layer-scene" data-view-mode="layers3d" data-layer-count={records.length} data-layer-candidate-count={layout.candidateCount} data-layer-truncated={layout.truncated ? "true" : "false"} data-layer-omitted-count={layout.omittedCount} style={sceneStyle} aria-label="3D hierarchy layers">
        <div className="layer-scene-inner">
          {records.map((record) => (
            <button
              className={`layer-plane ${record.isSelected ? "selected" : ""} ${record.isAncestor ? "ancestor" : ""} ${record.isDescendant ? "descendant" : ""} ${record.isVirtual ? "virtual" : ""}`}
              data-layer-node-id={record.id}
              data-layer-depth={record.depth}
              data-layer-selected={record.isSelected ? "true" : "false"}
              key={record.id}
              type="button"
              aria-label={`选择 ${nodeDisplayLabel(record.node)}，层级 ${record.depth}`}
              onPointerUp={(event) => event.stopPropagation()}
              onClick={(event) => selectPlane(event, record.node)}
              style={planeStyle(src, size, renderScale, camera, record)}
            >
              <span className="layer-plane-label">
                <strong>{nodeDisplayLabel(record.node)}</strong>
                <span>{record.node.className ?? "unknown"}</span>
                <em>L{record.depth}{record.isVirtual ? " · Accessibility" : ""}</em>
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="layer-scene-hud" aria-label="3D 层级辅助信息">
        <nav className="layer-breadcrumb" aria-label="当前层级路径">
          {breadcrumb.map((node, index) => (
            <span className="layer-breadcrumb-item" key={node.id}>
              {index > 0 && <span className="layer-breadcrumb-separator" aria-hidden="true">/</span>}
              <button type="button" onClick={() => onSelect(node)} aria-label={`选择层级 ${nodeDisplayLabel(node)}`}>{nodeDisplayLabel(node)}</button>
            </span>
          ))}
        </nav>
        <p className="layer-order-note">同层顺序优先参考 drawing-order/index/XML；相机围绕截图中心观察，不代表真实绘制 Z 序</p>
        {layout.truncated && <p className="layer-limit-note">已折叠 {layout.omittedCount} 个候选层，请缩小范围查看</p>}
      </div>
    </>
  );
}
