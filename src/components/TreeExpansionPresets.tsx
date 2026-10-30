import type { TreeExpansionPreset } from "../../shared/tree-collapse";
import "../styles/tree-expansion-presets.css";

export function TreeExpansionPresets({ disabledReason, onApply }: {
  disabledReason: string | null;
  onApply: (preset: TreeExpansionPreset) => void;
}) {
  return (
    <div className="tree-expansion-presets" role="group" aria-label="快捷展开层级">
      <span className="tree-expansion-label">层级</span>
      {([2, 4, "all"] as const).map(preset => (
        <button key={preset} className="tree-expansion-preset" type="button"
          disabled={Boolean(disabledReason)} data-expansion-preset={preset}
          aria-label={preset === "all" ? "展开当前树全部层级" : `展开当前树前 ${preset} 层，保留选中路径`}
          title={disabledReason ?? (preset === "all" ? "展开当前树全部层级，不修改默认折叠规则" : `显示当前树前 ${preset} 层，并保留选中控件的祖先路径；不修改默认折叠规则`)}
          onClick={() => onApply(preset)}>
          {preset === "all" ? "全部" : `前 ${preset} 层`}
        </button>
      ))}
    </div>
  );
}
