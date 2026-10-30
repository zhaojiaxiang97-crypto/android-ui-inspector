import type { CSSProperties } from "react";
import { LAYER_VIEW_PRESETS, ORBIT_PARAMETER_LIMITS, matchesLayerPreset, type LayerViewPreset, type OrbitCamera, type OrbitRotationMode } from "../../../shared/orbit-camera";
import { AppIcon } from "../../components/AppIcon";

export function LayerViewControls({ camera, rotationMode, disabled, style, completeStructure, onStructure, onPreset, onGap }: {
  camera: OrbitCamera;
  rotationMode: OrbitRotationMode;
  disabled: boolean;
  style: CSSProperties;
  completeStructure: boolean;
  onStructure: () => void;
  onPreset: (preset: LayerViewPreset) => void;
  onGap: (gap: number) => void;
}) {
  return <div className="layer-view-controls" style={style} role="group" aria-label="3D 视角与层距">
    <div className="layer-view-shortcuts" role="group" aria-label="图层视角">
      <span>视角</span>
      {(Object.keys(LAYER_VIEW_PRESETS) as LayerViewPreset[]).map(preset => <button key={preset} type="button" data-layer-preset={preset}
        disabled={disabled} aria-pressed={matchesLayerPreset(camera, preset, rotationMode)}
        title={preset === "front" ? "正面查看页面，自动适应画布" : preset === "stacked" ? "回到清晰的层叠视角，自动适应画布" : "拉开图层，兼顾页面内容与前后关系"}
        onClick={() => onPreset(preset)}>
        <AppIcon name={preset} size={16} /><span>{LAYER_VIEW_PRESETS[preset].label}</span>
      </button>)}
    </div>
    <label className="layer-view-gap" title="调整图层的展示间距，不改变控件的实际尺寸和测距结果">
      <span>层距</span>
      <input type="range" aria-label="画布图层间距" {...ORBIT_PARAMETER_LIMITS.layerGap} value={camera.layerGap}
        disabled={disabled} onChange={event => onGap(Number(event.target.value))} />
      <output aria-hidden="true">{camera.layerGap}</output>
    </label>
    <div className="layer-view-shortcuts">
      <button type="button" aria-pressed={completeStructure} disabled={disabled} onClick={onStructure}
        title="保留透明容器的完整边框与层距，水平查看结构；再次点击恢复原来的显示" aria-label="完整结构">
        <AppIcon name="hierarchy" size={16} /><span>完整结构</span>
      </button>
    </div>
  </div>;
}
