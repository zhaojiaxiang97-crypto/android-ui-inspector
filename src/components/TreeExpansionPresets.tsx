import type { TreeExpansionPreset } from "../../shared/tree-collapse";
import "../styles/tree-expansion-presets.css";

export function TreeExpansionPresets({ disabledReason, onApply }: {
  disabledReason: string | null;
  onApply: (preset: TreeExpansionPreset) => void;
}) {
  return (
    <div className="tree-expansion-presets" role="group" aria-label="快捷展开层级">
      <span className="tree-expansion-label">层级</span>
      {(["components", 2, 4, "all"] as const).map(preset => (
        <button key={preset} className="tree-expansion-preset" type="button"
          disabled={Boolean(disabledReason)} data-expansion-preset={preset}
          aria-label={preset === "components" ? "按组件查看当前树，保留选中路径" : preset === "all" ? "展开当前树全部层级" : `展开当前树前 ${preset} 层，保留选中路径`}
          title={disabledReason ?? (preset === "components" ? "整块查看卡片和导航栏；复杂页面先显示主要画面层，双击继续展开，保留选中路径；不修改默认规则" : preset === "all" ? "展开当前树全部层级，不修改默认折叠规则" : `显示当前树前 ${preset} 层，并保留选中控件的祖先路径；不修改默认折叠规则`)}
          onClick={() => onApply(preset)}>
          {preset === "components" ? "按组件" : preset === "all" ? "全部" : `前 ${preset} 层`}
        </button>
      ))}
    </div>
  );
}
