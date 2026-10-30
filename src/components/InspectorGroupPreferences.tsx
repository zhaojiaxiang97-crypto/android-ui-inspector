import { useState } from "react";
import { DEFAULT_INSPECTOR_GROUPS, INSPECTOR_GROUPS, type InspectorGroupPreference } from "../../shared/inspector-groups";

export function InspectorGroupPreferences({ preference, onSave }: {
  preference: InspectorGroupPreference; onSave?: (value: InspectorGroupPreference) => boolean;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const save = (value: InspectorGroupPreference) => {
    if (!onSave) return;
    setStatus(onSave(value) ? "属性分组已保存并生效。" : "已应用到本次窗口，但本机保存失败；重开后可能丢失。");
  };
  return <section className="preferences-section preferences-inspector-groups" aria-labelledby="preferences-inspector-groups-title">
    <h3 id="preferences-inspector-groups-title">属性分组</h3>
    <div className="preferences-inspector-group-options" aria-describedby="preferences-inspector-groups-help">
      {INSPECTOR_GROUPS.map(group => <label key={group.id}>
        <input type="checkbox" aria-label={`显示${group.label}`} checked={!preference.hidden.includes(group.id)} disabled={!onSave}
          onChange={event => save({ ...preference, hidden: event.currentTarget.checked
            ? preference.hidden.filter(id => id !== group.id) : [...preference.hidden, group.id] })} />
        {group.label}
      </label>)}
    </div>
    <p id="preferences-inspector-groups-help">勾选显示；手动展开与折叠也会保存在本机。搜索只临时展开匹配分组；快照保留完整属性。</p>
    <div className="preferences-actions">
      <button type="button" disabled={!onSave} onClick={() => save(DEFAULT_INSPECTOR_GROUPS)}>恢复属性分组默认</button>
    </div>
    <p role="status">{status ?? (onSave ? "恢复默认会显示全部分组，并重置展开与折叠状态。" : "当前窗口不支持修改属性分组设置。")}</p>
  </section>;
}
