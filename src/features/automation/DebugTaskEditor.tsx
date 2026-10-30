import { useEffect, useRef, useState } from "react";
import { EntryDialog } from "../../components/EntryDialog";
import { debugTaskDefinition, type DebugTaskCondition, type DebugTaskDefinition } from "../../../shared/debug-task";
import { debugTaskTemplateFile, type DebugTaskTemplate, type DebugTaskTemplateSaveInput, type DebugTaskTemplatesResult } from "../../../shared/debug-task-templates";
import type { DebugSessionState, UiNode, UiSnapshot } from "../../../shared/types";
import { conditionStates, countDebugTaskConditions, countSnapshotSelectorMatches, createDebugTaskDraft,
  debugTaskDefinitionBlockedReason, debugTaskDefinitionError, debugTaskSessionBlockedReason, nextDebugTaskEditorId,
  restoreDebugTaskTemplate, selectorFields, selectorFromSelectedNode } from "./debug-task-editor-model";
import "./debug-task-editor.css";

export type DebugTaskEditorApi = {
  loadDebugTaskTemplates(): Promise<DebugTaskTemplatesResult>;
  saveDebugTaskTemplate(input: DebugTaskTemplateSaveInput): Promise<DebugTaskTemplatesResult>;
  deleteDebugTaskTemplate(id: string): Promise<DebugTaskTemplatesResult>;
  defineDebugTask(input: { sessionId: string; definition: DebugTaskDefinition }): Promise<Record<string, unknown>>;
  checkDebugTask(input: { sessionId: string; taskId: string; checkpointId?: string }): Promise<Record<string, unknown>>;
};
export type DebugTaskEditorProps = {
  snapshot: UiSnapshot | null; selectedNode: UiNode | null; state: DebugSessionState | null;
  api: DebugTaskEditorApi; onClose: () => void;
};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function ConditionEditor({ condition, label, snapshot, selectedNode, removable, onChange, onRemove, onError }: {
  condition: DebugTaskCondition; label: string; snapshot: UiSnapshot | null; selectedNode: UiNode | null;
  removable: boolean; onChange: (condition: DebugTaskCondition) => void; onRemove: () => void; onError: (message: string) => void;
}) {
  const matches = countSnapshotSelectorMatches(snapshot, condition.selector);
  return <fieldset className="task-editor-condition" data-condition-id={condition.id}>
    <legend>{label}<code>{condition.id}</code></legend>
    <div className="task-editor-condition-actions">
      <label>条件<select aria-label={`${label}状态`} value={condition.state}
        onChange={event => onChange({ ...condition, state: event.target.value as DebugTaskCondition["state"] })}>
        {conditionStates.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select></label>
      <button type="button" data-task-action="use-selected-node" aria-label={`${label}使用选中控件`} disabled={!selectedNode || !snapshot?.root} onClick={() => {
        const result = selectorFromSelectedNode(snapshot, selectedNode);
        if (result.selector) onChange({ ...condition, selector: result.selector }); else onError(result.error!);
      }}>使用选中控件</button>
      <button type="button" aria-label={`删除${label}`} disabled={!removable} onClick={onRemove}>删除条件</button>
    </div>
    <div className="task-editor-selector-fields">
      {selectorFields.map(({ key, label: fieldLabel }) => <label key={key}>{fieldLabel}<input aria-label={`${label}${fieldLabel}`}
        data-task-field={key} maxLength={512} value={condition.selector[key] ?? ""} placeholder="留空表示不限制" onChange={event => {
          const selector = { ...condition.selector };
          if (event.target.value === "") delete selector[key]; else selector[key] = event.target.value;
          onChange({ ...condition, selector });
        }} /></label>)}
    </div>
    <p>{matches === null ? "至少填写一个属性；已填写的属性均按原文精确匹配。" : `此快照匹配 ${matches} 个控件，仅供编辑参考。`}</p>
  </fieldset>;
}

export function DebugTaskEditor({ snapshot, selectedNode, state, api, onClose }: DebugTaskEditorProps) {
  const [draft, setDraft] = useState<DebugTaskDefinition>(() => state?.task ? debugTaskDefinition.parse(state.task.definition) : createDebugTaskDraft());
  const [templates, setTemplates] = useState<DebugTaskTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [loadedTemplateId, setLoadedTemplateId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [checkpointId, setCheckpointId] = useState("");
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(false), pendingRef = useRef(false), stateRef = useRef(state), apiRef = useRef(api);
  stateRef.current = state; apiRef.current = api;

  function acceptTemplates(result: DebugTaskTemplatesResult) {
    if (result.error) { setError(result.error); return false; }
    const parsed = debugTaskTemplateFile.safeParse({ version: 1, templates: result.templates });
    if (!parsed.success) { setError("读取的模板内容无效；当前草稿已保留。"); return false; }
    setTemplates(parsed.data.templates);
    return true;
  }

  useEffect(() => {
    mounted.current = true;
    let current = true;
    pendingRef.current = true; setPending("读取模板");
    apiRef.current.loadDebugTaskTemplates().then(result => { if (current) acceptTemplates(result); }, reason => { if (current) setError(errorMessage(reason)); })
      .finally(() => { if (current) { pendingRef.current = false; setPending(null); } });
    return () => { current = false; mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!state?.active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state?.id, state?.active]);
  useEffect(() => { setCheckpointId(""); }, [state?.id, state?.task?.id]);

  const edit = (next: DebugTaskDefinition) => { setDraft(next); setError(null); setNotice(null); };
  async function run(label: string, operation: () => Promise<void>) {
    if (pendingRef.current) return;
    pendingRef.current = true; setPending(label); setError(null); setNotice(null);
    try { await operation(); }
    catch (reason) { if (mounted.current) setError(errorMessage(reason)); }
    finally { if (mounted.current) { pendingRef.current = false; setPending(null); } }
  }
  const selectedTemplate = templates.find(item => item.id === selectedTemplateId);
  const definitionError = debugTaskDefinitionError(draft);
  const defineBlocked = debugTaskDefinitionBlockedReason(state, now);
  const checkBlocked = debugTaskSessionBlockedReason(state, now);
  const conditionCount = countDebugTaskConditions(draft);
  const task = state?.task;
  const currentCheck = task?.checks.find(item => item.checkpointId === (checkpointId || null));
  const validCheckpoint = !checkpointId || task?.definition.checkpoints.some(stage => stage.id === checkpointId);

  function save(asNew: boolean) {
    const input = { ...(!asNew && loadedTemplateId ? { id: loadedTemplateId } : {}), name, definition: draft };
    void run("保存模板", async () => {
      const result = await api.saveDebugTaskTemplate(input);
      if (!mounted.current || !acceptTemplates(result)) return;
      const saved = result.templates.find(item => input.id ? item.id === input.id : item.name === name.trim());
      if (saved) { setLoadedTemplateId(saved.id); setSelectedTemplateId(saved.id); }
      setNotice("模板已保存在本机。");
    });
  }

  function requestSession(check: boolean) {
    const session = stateRef.current;
    const blocked = check ? debugTaskSessionBlockedReason(session) : debugTaskDefinitionBlockedReason(session);
    if (blocked || !session) { setError(blocked); return; }
    if (check && (!session.task || checkpointId && !session.task.definition.checkpoints.some(stage => stage.id === checkpointId))) {
      setError("当前会话没有对应的固定任务或阶段，请重新选择。"); return;
    }
    if (!check && definitionError) { setError(definitionError); return; }
    const sessionId = session.id;
    void run(check ? "只读验收" : "固定任务", async () => {
      const result = check && session.task
        ? await api.checkDebugTask({ sessionId, taskId: session.task.id, ...(checkpointId ? { checkpointId } : {}) })
        : await api.defineDebugTask({ sessionId, definition: debugTaskDefinition.parse(draft) });
      if (!mounted.current) return;
      if (stateRef.current?.id !== sessionId || !stateRef.current.active) {
        setError("会话已结束或切换；请查看对应会话记录，本地草稿已保留。"); return;
      }
      const message = typeof result.message === "string" ? result.message : check ? "验收请求已完成，结论见当前会话记录。" : "任务已固定到当前会话。";
      if (result.isError === true) setError(message); else setNotice(message);
    });
  }

  function conditionList(conditions: DebugTaskCondition[], prefix: string, update: (conditions: DebugTaskCondition[]) => void) {
    return <>
      {conditions.map((condition, index) => <ConditionEditor key={condition.id} condition={condition} label={`${prefix}条件${index + 1}`}
        snapshot={snapshot} selectedNode={selectedNode} removable={conditions.length > 1} onError={setError}
        onChange={next => update(conditions.map(item => item.id === condition.id ? next : item))}
        onRemove={() => update(conditions.filter(item => item.id !== condition.id))} />)}
      <button type="button" disabled={conditions.length >= 10 || conditionCount >= 20} onClick={() => update([...conditions,
        { id: nextDebugTaskEditorId(draft, "condition"), selector: {}, state: "visible" }])}>添加{prefix}条件</button>
    </>;
  }

  return <EntryDialog className="debug-task-editor" labelledBy="debug-task-editor-title" onClose={onClose}>
    <header className="entry-dialog-heading"><h2 id="debug-task-editor-title">任务与模板</h2>
      <button type="button" data-task-action="close" className="entry-dialog-close" aria-label="关闭任务编辑器" onClick={onClose} autoFocus>×</button></header>
    <p className="task-editor-intro">声明目标和精确页面条件。模板保存在本机；固定到会话后不能改写。</p>
    <div className="task-editor-layout">
      <aside className="task-editor-templates" aria-label="本地任务模板">
        <div className="task-editor-section-heading"><h3>本地模板</h3><span>{templates.length} / 30</span></div>
        <select data-task-field="template-list" size={6} aria-label="已保存的任务模板" value={selectedTemplateId} onChange={event => setSelectedTemplateId(event.target.value)}>
          <option value="" disabled>{templates.length ? "选择模板" : "暂无模板"}</option>
          {templates.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <button type="button" data-task-action="load" disabled={!selectedTemplate || Boolean(pending)} onClick={() => {
          if (!selectedTemplate) return;
          edit(restoreDebugTaskTemplate(selectedTemplate)); setName(selectedTemplate.name); setLoadedTemplateId(selectedTemplate.id);
          setNotice("已读取全部阶段和条件，可编辑后保存或复用。");
        }}>读取并替换草稿</button>
        <div className="task-editor-template-tools">
          <button type="button" data-task-action="new" disabled={Boolean(pending)} onClick={() => { edit(createDebugTaskDraft()); setName(""); setLoadedTemplateId(null); }}>新任务</button>
          <button type="button" data-task-action="refresh" disabled={Boolean(pending)} onClick={() => void run("读取模板", async () => {
            const result = await api.loadDebugTaskTemplates(); if (mounted.current && acceptTemplates(result)) setNotice("模板列表已刷新，草稿已保留。");
          })}>刷新列表</button>
          <button type="button" data-task-action="delete" disabled={!selectedTemplate || Boolean(pending)} onClick={() => void run("删除模板", async () => {
            const result = await api.deleteDebugTaskTemplate(selectedTemplateId);
            if (!mounted.current || !acceptTemplates(result)) return;
            if (loadedTemplateId === selectedTemplateId) setLoadedTemplateId(null);
            setSelectedTemplateId(""); setNotice("模板已删除，编辑中的草稿已保留。");
          })}>删除模板</button>
        </div>
        <label className="task-editor-field">模板名称<input data-task-field="name" aria-label="模板名称" value={name} maxLength={128}
          onChange={event => { setName(event.target.value); setError(null); }} placeholder="例如：动态页面检查" /></label>
        <button type="button" data-task-action="save" disabled={Boolean(pending) || Boolean(definitionError) || !name.trim()} onClick={() => save(false)}>{loadedTemplateId ? "更新模板" : "保存模板"}</button>
        {loadedTemplateId && <button type="button" data-task-action="save-as-new" disabled={Boolean(pending) || Boolean(definitionError) || !name.trim()} onClick={() => save(true)}>另存为新模板</button>}
        <p>模板可以离线编辑。选择列表后点击读取，才会替换草稿。</p>
      </aside>
      <main className="task-editor-draft" aria-label="任务草稿">
        <label className="task-editor-field task-editor-goal">任务目标<textarea data-task-field="goal" rows={2} maxLength={1024} aria-label="任务目标" value={draft.goal}
          onChange={event => edit({ ...draft, goal: event.target.value })} placeholder="说明希望到达的状态；验收按下面的页面条件判断。" /></label>
        <div className="task-editor-selection"><span>{selectedNode && snapshot?.root ? `选中控件：${selectedNode.text || selectedNode.resourceId || selectedNode.className || selectedNode.id}` : "未选择控件，可手动填写属性。"}</span>
          <small>当前快照只用于生成和预览匹配条件，不作为本次验收证据。</small></div>
        <div className="task-editor-section-heading"><h3>按序阶段</h3><span>{draft.checkpoints.length} / 5 阶段 · {conditionCount} / 20 条件</span></div>
        {draft.checkpoints.map((stage, index) => <section className="task-editor-stage" key={stage.id} aria-label={`阶段${index + 1}`}>
          <div className="task-editor-stage-heading"><label className="task-editor-field">阶段 {index + 1}<input aria-label={`阶段${index + 1}名称`} maxLength={256} value={stage.title}
            onChange={event => edit({ ...draft, checkpoints: draft.checkpoints.map(item => item.id === stage.id ? { ...item, title: event.target.value } : item) })} /></label>
            <button type="button" aria-label={`阶段${index + 1}上移`} disabled={index === 0} onClick={() => {
              const stages = [...draft.checkpoints]; [stages[index - 1], stages[index]] = [stages[index], stages[index - 1]]; edit({ ...draft, checkpoints: stages });
            }}>上移</button>
            <button type="button" aria-label={`阶段${index + 1}下移`} disabled={index === draft.checkpoints.length - 1} onClick={() => {
              const stages = [...draft.checkpoints]; [stages[index + 1], stages[index]] = [stages[index], stages[index + 1]]; edit({ ...draft, checkpoints: stages });
            }}>下移</button>
            <button type="button" aria-label={`删除阶段${index + 1}`} onClick={() => edit({ ...draft, checkpoints: draft.checkpoints.filter(item => item.id !== stage.id) })}>删除阶段</button>
          </div>
          {conditionList(stage.conditions, `阶段${index + 1}`, conditions => edit({ ...draft, checkpoints: draft.checkpoints.map(item => item.id === stage.id ? { ...item, conditions } : item) }))}
        </section>)}
        <button type="button" disabled={draft.checkpoints.length >= 5 || conditionCount >= 20} onClick={() => edit({ ...draft, checkpoints: [...draft.checkpoints,
          { id: nextDebugTaskEditorId(draft, "stage"), title: `阶段 ${draft.checkpoints.length + 1}`, conditions: [{ id: nextDebugTaskEditorId(draft, "condition"), selector: {}, state: "visible" }] }] })}>添加阶段</button>
        <section className="task-editor-final"><h3>最终条件</h3>
          {conditionList(draft.finalConditions, "最终", finalConditions => edit({ ...draft, finalConditions }))}</section>
      </main>
    </div>
    <section className="task-editor-session" aria-label="当前授权会话">
      <div className="task-editor-section-heading"><h3>当前会话</h3><span>{state?.active ? `${state.serial} · ${state.packageName}` : "未授权"}</span></div>
      <p>{defineBlocked ?? "请在首次手机输入前固定草稿；固定后可只读验收阶段和最终条件。"}</p>
      {task && <p className="task-editor-fixed-goal">已固定目标：{task.definition.goal}</p>}
      <div className="task-editor-session-actions"><button type="button" data-task-action="define" className="task-editor-primary"
        disabled={Boolean(pending) || Boolean(defineBlocked) || Boolean(definitionError)} onClick={() => requestSession(false)}>固定草稿到当前会话</button>
        {task && <><select data-task-field="checkpoint" aria-label="验收阶段" value={checkpointId} onChange={event => setCheckpointId(event.target.value)}>
          <option value="">最终条件</option>{task.definition.checkpoints.map(stage => <option key={stage.id} value={stage.id}>{stage.title}</option>)}
        </select><button type="button" data-task-action="check" disabled={Boolean(pending) || Boolean(checkBlocked) || !validCheckpoint} onClick={() => requestSession(true)}>只读验收</button></>}
      </div>
      {currentCheck && <p className="task-editor-check">最近验收：当时{ { passed: "通过", failed: "失败", insufficient_evidence: "证据不足" }[currentCheck.status] } · {new Date(currentCheck.checkedAt).toLocaleString()}。{currentCheck.reason} 继续操作后需要重新验收。</p>}
    </section>
    <div className="task-editor-message" aria-live="polite">{error ? <p role="alert">{error}</p> : <p role="status">{pending ? `正在${pending}…` : notice ?? definitionError ?? "草稿已就绪。"}</p>}</div>
  </EntryDialog>;
}
