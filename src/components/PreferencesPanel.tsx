import { useState } from "react";
import type { TreeDoubleClickAction } from "../../shared/types";
import { MAX_COLLAPSE_PREFERENCE_LENGTH, parseTreeCollapsePreference, type TreeCollapsePreference } from "../../shared/tree-collapse";
import { commandShortcut, doubleClickChoices, workbenchCommands } from "../../shared/workbench-commands";
import { EntryDialog } from "./EntryDialog";
import type { ColorAliasPreference } from "../../shared/inspector-colors";
import { ColorAliasPreferences } from "./ColorAliasPreferences";
import { DEFAULT_INSPECTOR_GROUPS, type InspectorGroupPreference } from "../../shared/inspector-groups";
import { InspectorGroupPreferences } from "./InspectorGroupPreferences";
import { AppearancePreferences } from "./AppearancePreferences";
import { DEFAULT_APPEARANCE, type AppearancePreference, type ResolvedAppearance } from "../../shared/appearance";
import { ContextHintPreferences } from "./ContextHintPreferences";

export function PreferencesPanel({ doubleClickAction, onChange, treeCollapsePreference, onCollapseChange, onApplyCollapse, canApplyCollapse, colorAliases, onSaveColorAliases, inspectorGroups = DEFAULT_INSPECTOR_GROUPS, onSaveInspectorGroups, contextHintAcknowledgedCount = 0, onResetContextHints, appearance = DEFAULT_APPEARANCE, resolvedAppearance = "dark", onAppearanceChange, appearanceSaveError = false, onClose }: {
  doubleClickAction: TreeDoubleClickAction; onChange: (value: TreeDoubleClickAction) => void; onClose: () => void;
  treeCollapsePreference: TreeCollapsePreference; onCollapseChange: (value: TreeCollapsePreference) => void;
  onApplyCollapse: (value: TreeCollapsePreference) => void; canApplyCollapse: boolean;
  colorAliases: ColorAliasPreference; onSaveColorAliases: (value: ColorAliasPreference) => boolean;
  inspectorGroups?: InspectorGroupPreference; onSaveInspectorGroups?: (value: InspectorGroupPreference) => boolean;
  contextHintAcknowledgedCount?: number; onResetContextHints?: () => boolean;
  appearance?: AppearancePreference; resolvedAppearance?: ResolvedAppearance;
  onAppearanceChange?: (value: AppearancePreference) => boolean; appearanceSaveError?: boolean;
}) {
  const [depth, setDepth] = useState(treeCollapsePreference.depth?.toString() ?? "");
  const [classes, setClasses] = useState(treeCollapsePreference.classes.join("\n"));
  const [collapseStatus, setCollapseStatus] = useState<string | null>(null);
  const names = classes.split(/\r?\n/).map(name => name.trim()).filter(Boolean);
  const validDepth = !depth.trim() || /^\d+$/.test(depth.trim()) && Number(depth) >= 1 && Number(depth) <= 200;
  const preference = validDepth ? parseTreeCollapsePreference({ version: 1, depth: depth.trim() ? Number(depth) : null, classes: names }) : null;
  const error = !validDepth ? "层级须为 1–200 的整数；留空表示不限。" : !preference
    ? "类型须为完整类名或短类名，每行一项，最多 32 项、每项 200 字；不支持通配符。" : null;
  return <EntryDialog className="preferences-panel" labelledBy="preferences-title" onClose={onClose}>
    <div className="entry-dialog-heading">
      <h2 id="preferences-title">偏好设置</h2>
      <button type="button" className="entry-dialog-close" aria-label="关闭偏好设置" onClick={onClose} autoFocus>×</button>
    </div>
    <section className="preferences-section" aria-labelledby="preferences-interaction">
      <h3 id="preferences-interaction">树与画布</h3>
      <label className="preferences-field">双击行为
        <select aria-label="双击行为" value={doubleClickAction} onChange={event => onChange(event.currentTarget.value as TreeDoubleClickAction)}>
          {doubleClickChoices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </select>
      </label>
      <p>立即生效并保存在本机。筛选不会改变原来的折叠状态。</p>
    </section>
    <AppearancePreferences preference={appearance} resolved={resolvedAppearance} onChange={onAppearanceChange} saveError={appearanceSaveError} />
    <section className="preferences-section" aria-labelledby="preferences-collapse">
      <h3 id="preferences-collapse">默认折叠</h3>
      <label className="preferences-field">初始显示层级
        <input type="number" aria-label="初始显示层级" aria-describedby="preferences-depth-help" min="1" max="200" step="1" placeholder="不限" value={depth}
          onChange={event => { setDepth(event.currentTarget.value); setCollapseStatus(null); }} />
      </label>
      <p id="preferences-depth-help">根节点为第 1 层。留空表示不限，到指定层级后收起子节点。</p>
      <label className="preferences-class-field">默认收起的类型
        <textarea aria-label="默认收起的类型" aria-describedby="preferences-class-help" rows={3} maxLength={MAX_COLLAPSE_PREFERENCE_LENGTH}
          placeholder={"SvgView\ncom.example.LoadingView"} value={classes} onChange={event => { setClasses(event.currentTarget.value); setCollapseStatus(null); }} />
      </label>
      <p id="preferences-class-help">每行一个类名，区分大小写；完整类名只匹配该类型，短类名匹配各包的同名类型。默认全部展开，完整树始终保留。</p>
      {error && <p className="preferences-error" role="alert">{error}</p>}
      <div className="preferences-actions">
        <button type="button" disabled={!preference} onClick={() => {
          if (preference) { onCollapseChange(preference); setCollapseStatus("设置已保存，下次采集或打开快照时生效。"); }
        }}>保存设置</button>
        <button type="button" disabled={!preference || !canApplyCollapse} title={canApplyCollapse ? "重新设置当前树的展开状态，保留选中节点的路径" : "打开快照，退出聚焦、清除筛选，并等待采集或刷新结束后可应用"}
          onClick={() => { if (preference) { onApplyCollapse(preference); setCollapseStatus("已保存并应用到当前树，保留选中节点的路径。"); } }}>应用到当前树</button>
        <button type="button" onClick={() => { setDepth(""); setClasses(""); setCollapseStatus(null); }}>清空规则</button>
      </div>
      <p role="status">{collapseStatus ?? "保存用于新快照；应用到当前树会重新设置展开状态。搜索和定位仍能找到收起的控件。"}</p>
    </section>
    <InspectorGroupPreferences preference={inspectorGroups} onSave={onSaveInspectorGroups} />
    <ColorAliasPreferences aliases={colorAliases} onSave={onSaveColorAliases} />
    <ContextHintPreferences acknowledgedCount={contextHintAcknowledgedCount} onReset={onResetContextHints} />
    <section className="preferences-section" aria-labelledby="preferences-shortcuts">
      <h3 id="preferences-shortcuts">快捷键</h3>
      <dl className="preferences-shortcuts">
        {(["capture", "cancel", "refresh", "search", "save", "export-json", "home", "preferences"] as const).map(type =>
          <div key={type}><dt>{workbenchCommands[type].label}</dt><dd><kbd>{commandShortcut(type)}</kbd></dd></div>)}
      </dl>
      <p>画布内：+ / − 缩放，0 适应，空格或 Shift 平移。</p>
    </section>
  </EntryDialog>;
}
