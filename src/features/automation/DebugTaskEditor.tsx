import { AppIcon } from "../../components/AppIcon";
import { useEffect, useRef, useState } from "react";
import { EntryDialog } from "../../components/EntryDialog";
import { SelectorMatchDiagnostics } from "./SelectorMatchDiagnostics";
import { debugTaskDefinition, type DebugTaskCondition, type DebugTaskDefinition } from "../../../shared/debug-task";
import { debugTaskFragmentSaveInput, debugTaskTemplateFile, type DebugTaskFragment, type DebugTaskFragmentSaveInput,
  type DebugTaskFragmentsResult, type DebugTaskTemplate, type DebugTaskTemplateExportResult, type DebugTaskTemplateImportResult,
  type DebugTaskTemplateSaveInput, type DebugTaskTemplatesResult } from "../../../shared/debug-task-templates";
import type { DebugSessionState, UiNode, UiSnapshot } from "../../../shared/types";
import { conditionStates, countDebugTaskConditions, createDebugTaskDraft,
  debugTaskDefinitionBlockedReason, debugTaskDefinitionError, debugTaskSessionBlockedReason, nextDebugTaskEditorId,
  insertDebugTaskFragment, restoreDebugTaskTemplate, selectorFields, selectorFromSelectedNode } from "./debug-task-editor-model";
import "./debug-task-editor.css";

export type DebugTaskEditorApi = {
  loadDebugTaskTemplates(): Promise<DebugTaskTemplatesResult>;
  saveDebugTaskTemplate(input: DebugTaskTemplateSaveInput): Promise<DebugTaskTemplatesResult>;
  deleteDebugTaskTemplate(id: string): Promise<DebugTaskTemplatesResult>;
  loadDebugTaskFragments?(): Promise<DebugTaskFragmentsResult>;
  saveDebugTaskFragment?(input: DebugTaskFragmentSaveInput): Promise<DebugTaskFragmentsResult>;
  deleteDebugTaskFragment?(id: string): Promise<DebugTaskFragmentsResult>;
  importDebugTaskTemplates?(): Promise<DebugTaskTemplateImportResult>;
  exportDebugTaskTemplates?(): Promise<DebugTaskTemplateExportResult>;
  defineDebugTask(input: { sessionId: string; definition: DebugTaskDefinition }): Promise<Record<string, unknown>>;
  checkDebugTask(input: { sessionId: string; taskId: string; checkpointId?: string }): Promise<Record<string, unknown>>;
};
export type DebugTaskEditorProps = {
  snapshot: UiSnapshot | null; selectedNode: UiNode | null; state: DebugSessionState | null;
  api: DebugTaskEditorApi; onClose: () => void;
  open?: boolean;
  onSelectMatch?: (nodeId: string, sourceSnapshot: UiSnapshot) => void;
};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function ConditionEditor({ condition, label, snapshot, selectedNode, removable, onChange, onRemove, onError, onSaveFragment, onSelectMatch }: {
  condition: DebugTaskCondition; label: string; snapshot: UiSnapshot | null; selectedNode: UiNode | null;
  removable: boolean; onChange: (condition: DebugTaskCondition) => void; onRemove: () => void; onError: (message: string) => void;
  onSaveFragment?: (conditionId: string) => void;
  onSelectMatch?: (nodeId: string, sourceSnapshot: UiSnapshot) => void;
}) {
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
      <button type="button" data-task-action="save-condition-fragment" aria-label={`${label}存为片段`} disabled={!onSaveFragment}
        onClick={() => onSaveFragment?.(condition.id)}>存为片段</button>
    </div>
    <div className="task-editor-selector-fields">
      {selectorFields.map(({ key, label: fieldLabel }) => <label key={key}>{fieldLabel}<input aria-label={`${label}${fieldLabel}`}
        data-task-field={key} maxLength={512} value={condition.selector[key] ?? ""} placeholder="留空表示不限制" onChange={event => {
          const selector = { ...condition.selector };
          if (event.target.value === "") delete selector[key]; else selector[key] = event.target.value;
          onChange({ ...condition, selector });
        }} /></label>)}
    </div>
    <SelectorMatchDiagnostics snapshot={snapshot} selector={condition.selector} onSelectMatch={onSelectMatch} />
  </fieldset>;
}

export function DebugTaskEditor({ snapshot, selectedNode, state, api, onClose, open = true, onSelectMatch }: DebugTaskEditorProps) {
  const [draft, setDraft] = useState<DebugTaskDefinition>(() => state?.task ? debugTaskDefinition.parse(state.task.definition) : createDebugTaskDraft());
  const [templates, setTemplates] = useState<DebugTaskTemplate[]>([]);
  const [fragments, setFragments] = useState<DebugTaskFragment[]>([]);
  const [libraryTab, setLibraryTab] = useState<"templates" | "fragments">("templates");
  const [selectedFragmentId, setSelectedFragmentId] = useState("");
  const [fragmentName, setFragmentName] = useState("");
  const [fragmentTarget, setFragmentTarget] = useState("");
  const [fragmentSource, setFragmentSource] = useState<{ kind: "condition" | "stage"; id: string } | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [loadedTemplateId, setLoadedTemplateId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [checkpointId, setCheckpointId] = useState("");
  const [now, setNow] = useState(Date.now);
  const fragmentSaveRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false), pendingRef = useRef(false), stateRef = useRef(state), apiRef = useRef(api);
  stateRef.current = state; apiRef.current = api;

  function acceptTemplates(result: DebugTaskTemplatesResult) {
    if (result.error) { setError(result.error); return false; }
    const parsed = debugTaskTemplateFile.safeParse({ version: 1, templates: result.templates });
    if (!parsed.success) { setError("读取的模板内容无效；当前草稿已保留。"); return false; }
    setTemplates(parsed.data.templates);
    return true;
  }
  function acceptFragments(result: DebugTaskFragmentsResult) {
    if (result.error) { setError(result.error); return false; }
    const parsed = debugTaskTemplateFile.safeParse({ version: 1, templates: [], fragments: result.fragments });
    if (!parsed.success) { setError("读取的片段内容无效；当前草稿已保留。"); return false; }
    setFragments(parsed.data.fragments);
    return true;
  }

  useEffect(() => {
    mounted.current = true;
    let current = true;
    pendingRef.current = true; setPending("读取模板");
    Promise.all([apiRef.current.loadDebugTaskTemplates(), apiRef.current.loadDebugTaskFragments?.() ?? Promise.resolve(null)])
      .then(([result, fragmentResult]) => { if (current) { acceptTemplates(result); if (fragmentResult) acceptFragments(fragmentResult); } }, reason => { if (current) setError(errorMessage(reason)); })
      .finally(() => { if (current) { pendingRef.current = false; setPending(null); } });
    return () => { current = false; mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!state?.active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state?.id, state?.active]);
  useEffect(() => { setCheckpointId(""); }, [state?.id, state?.task?.id]);
  useEffect(() => {
    if (!fragmentSource) return;
    fragmentSaveRef.current?.scrollIntoView({ block: "nearest" });
    fragmentSaveRef.current?.querySelector("input")?.focus({ preventScroll: true });
  }, [fragmentSource]);

  const edit = (next: DebugTaskDefinition) => { setDraft(next); setError(null); setNotice(null);
    if (fragmentTarget && !next.checkpoints.some(stage => stage.id === fragmentTarget)) setFragmentTarget(""); };
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
  const selectedFragment = fragments.find(item => item.id === selectedFragmentId);
  const sourceCondition = fragmentSource?.kind === "condition" ? [...draft.finalConditions, ...draft.checkpoints.flatMap(stage => stage.conditions)].find(item => item.id === fragmentSource.id) : undefined;
  const sourceStage = fragmentSource?.kind === "stage" ? draft.checkpoints.find(stage => stage.id === fragmentSource.id) : undefined;
  const fragmentInput = sourceCondition ? { name: fragmentName, kind: "condition" as const, condition: sourceCondition }
    : sourceStage ? { name: fragmentName, kind: "stage" as const, stage: sourceStage } : null;
  const canSaveFragment = Boolean(api.loadDebugTaskFragments && api.saveDebugTaskFragment);
  function beginFragment(kind: "condition" | "stage", id: string) {
    setFragmentSource({ kind, id }); setFragmentName(""); setLibraryTab("fragments"); setError(null);
    setNotice("为片段填写名称，再点击保存片段。原条件和阶段会保留在草稿中。");
  }
  function share(importing: boolean) {
    if (importing && !api.importDebugTaskTemplates || !importing && !api.exportDebugTaskTemplates) return;
    void run(importing ? "导入 JSON" : "导出 JSON", async () => {
      if (importing) {
        const result = await api.importDebugTaskTemplates!();
        if (!mounted.current) return;
        if (result.canceled) { setNotice("已取消导入，模板、片段和草稿已保留。"); return; }
        if (result.error) { setError(result.error); return; }
        const parsed = debugTaskTemplateFile.safeParse({ version: 1, templates: result.templates, fragments: result.fragments });
        if (!result.filePath || !parsed.success) { setError("导入未返回有效模板库；当前草稿已保留。"); return; }
        setTemplates(parsed.data.templates); setFragments(parsed.data.fragments);
        const skipped = [...result.skipped.templates.map(item => `模板「${item}」`), ...result.skipped.fragments.map(item => `片段「${item}」`)];
        setNotice(`已导入 ${result.imported.templates} 份模板、${result.imported.fragments} 份片段。${skipped.length ? `本机同名内容已保留：${skipped.join("、")}。` : ""}草稿未替换。`);
      } else {
        const result = await api.exportDebugTaskTemplates!();
        if (!mounted.current) return;
        if (result.canceled) setNotice("已取消导出。");
        else if (result.error) setError(result.error);
        else if (!result.filePath) setError("导出未返回保存文件，请重试。");
        else setNotice(`已导出 ${result.templateCount} 份模板、${result.fragmentCount} 份片段到 ${result.filePath}。`);
      }
    });
  }

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
        onSelectMatch={onSelectMatch}
        onSaveFragment={canSaveFragment && !pending ? id => beginFragment("condition", id) : undefined}
        onChange={next => update(conditions.map(item => item.id === condition.id ? next : item))}
        onRemove={() => update(conditions.filter(item => item.id !== condition.id))} />)}
      <button type="button" disabled={conditions.length >= 10 || conditionCount >= 20} onClick={() => update([...conditions,
        { id: nextDebugTaskEditorId(draft, "condition"), selector: {}, state: "visible" }])}>添加{prefix}条件</button>
    </>;
  }

  return <EntryDialog className="debug-task-editor" labelledBy="debug-task-editor-title" onClose={onClose} open={open}>
    <header className="entry-dialog-heading"><h2 id="debug-task-editor-title">任务与模板</h2>
      <button type="button" data-task-action="close" className="entry-dialog-close" aria-label="关闭任务编辑器" onClick={onClose} autoFocus><AppIcon name="close" size={14} /></button></header>
    <p className="task-editor-intro">声明目标和精确页面条件。模板保存在本机；固定到会话后不能改写。</p>
    <div className="task-editor-layout">
      <aside className="task-editor-templates" aria-label="本地任务模板">
        <div className="task-editor-library-tabs" aria-label="本地库内容">
          <button type="button" data-task-action="show-templates" aria-pressed={libraryTab === "templates"} onClick={() => setLibraryTab("templates")}>模板 {templates.length}</button>
          <button type="button" data-task-action="show-fragments" aria-pressed={libraryTab === "fragments"} disabled={!api.loadDebugTaskFragments} onClick={() => setLibraryTab("fragments")}>片段 {fragments.length}</button>
        </div>
        {libraryTab === "templates" ? <>
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
        </> : <>
          <div className="task-editor-section-heading"><h3>条件与阶段片段</h3><span>{fragments.length} / 60</span></div>
          <select data-task-field="fragment-list" aria-label="已保存的条件与阶段片段" size={5} value={selectedFragmentId} onChange={event => setSelectedFragmentId(event.target.value)}>
            <option value="" disabled>{fragments.length ? "选择片段" : "暂无片段"}</option>
            {fragments.map(item => <option key={item.id} value={item.id}>{item.kind === "stage" ? "阶段" : "条件"} · {item.name}</option>)}
          </select>
          <label className="task-editor-field">插入位置<select data-task-field="fragment-target" aria-label="条件片段插入位置" value={fragmentTarget}
            disabled={selectedFragment?.kind === "stage"} onChange={event => setFragmentTarget(event.target.value)}>
            <option value="">最终条件</option>{draft.checkpoints.map((stage, index) => <option key={stage.id} value={stage.id}>阶段 {index + 1} · {stage.title}</option>)}
          </select></label>
          {selectedFragment?.kind === "stage" && <p>完整阶段追加到阶段末尾，保留条件顺序。</p>}
          <button type="button" data-task-action="fragment-insert" disabled={!selectedFragment || Boolean(pending)} onClick={() => {
            if (!selectedFragment) return;
            const result = insertDebugTaskFragment(draft, selectedFragment, fragmentTarget || null);
            if (result.error) { setError(result.error); return; }
            edit(result.definition); setNotice("片段已插入草稿，使用新的编号；本机片段已保留。");
          }}>插入当前草稿</button>
          <div className="task-editor-template-tools">
            <button type="button" data-task-action="fragment-refresh" disabled={Boolean(pending) || !api.loadDebugTaskFragments} onClick={() => void run("读取片段", async () => {
              const result = await api.loadDebugTaskFragments!(); if (mounted.current && acceptFragments(result)) setNotice("片段列表已刷新，草稿已保留。");
            })}>刷新片段</button>
            <button type="button" data-task-action="fragment-delete" disabled={!selectedFragment || Boolean(pending) || !api.deleteDebugTaskFragment} onClick={() => void run("删除片段", async () => {
              const result = await api.deleteDebugTaskFragment!(selectedFragmentId);
              if (!mounted.current || !acceptFragments(result)) return;
              setSelectedFragmentId(""); setNotice("片段已删除；已插入的条件和草稿已保留。");
            })}>删除片段</button>
          </div>
          {fragmentSource ? <div className="task-editor-fragment-save" ref={fragmentSaveRef}>
            <p>{fragmentSource.kind === "stage" ? "待保存完整阶段" : "待保存单个条件"}{!fragmentInput ? "：原内容已删除，请重新选择。" : "：填写名称后保存。"}</p>
            <label className="task-editor-field">片段名称<input data-task-field="fragment-name" aria-label="片段名称" value={fragmentName} maxLength={128}
              onChange={event => { setFragmentName(event.target.value); setError(null); }} /></label>
            <div className="task-editor-template-tools"><button type="button" data-task-action="fragment-save"
              disabled={Boolean(pending) || !canSaveFragment || !debugTaskFragmentSaveInput.safeParse(fragmentInput).success} onClick={() => void run("保存片段", async () => {
                if (!fragmentInput) throw new Error("原条件或阶段已不存在，请重新选择。");
                const result = await api.saveDebugTaskFragment!(fragmentInput);
                if (!mounted.current || !acceptFragments(result)) return;
                const saved = result.fragments.find(item => item.name === fragmentName.trim());
                if (!saved) { setError("未返回已保存的片段；草稿和片段名称已保留，请刷新后重试。"); return; }
                setSelectedFragmentId(saved.id);
                setFragmentSource(null); setFragmentName(""); setNotice("命名片段已保存在本机，草稿已保留。");
              })}>保存片段</button><button type="button" data-task-action="fragment-cancel-save" disabled={Boolean(pending)} onClick={() => {
                setFragmentSource(null); setFragmentName(""); setNotice("已取消保存片段，草稿已保留。");
              }}>取消</button></div>
          </div> : <p>在条件卡或阶段标题旁点击“存为片段”，可保存后重复插入。</p>}
        </>}
        <div className="task-editor-sharing-actions"><button type="button" data-task-action="import" disabled={Boolean(pending) || !api.importDebugTaskTemplates} onClick={() => share(true)}>导入 JSON</button>
          <button type="button" data-task-action="export" disabled={Boolean(pending) || !api.exportDebugTaskTemplates || !templates.length && !fragments.length} onClick={() => share(false)}>导出 JSON</button></div>
        <p className="task-editor-sharing-note">导入和导出包含库中的模板及片段；编辑中的草稿需先保存。{!api.importDebugTaskTemplates || !api.exportDebugTaskTemplates || !api.loadDebugTaskFragments ? "当前接口尚未接入部分共享功能，对应按钮不可用。" : ""}</p>
      </aside>
      <main className="task-editor-draft" aria-label="任务草稿">
        <label className="task-editor-field task-editor-goal">任务目标<textarea data-task-field="goal" rows={2} maxLength={1024} aria-label="任务目标" value={draft.goal}
          onChange={event => edit({ ...draft, goal: event.target.value })} placeholder="说明希望到达的状态；验收按下面的页面条件判断。" /></label>
        <div className="task-editor-selection"><span>{selectedNode && snapshot?.root ? `选中控件：${selectedNode.text || selectedNode.resourceId || selectedNode.className || selectedNode.id}` : "未选择控件，可手动填写属性。"}</span>
          <small>当前快照只用于生成和预览匹配条件，不作为本次验收证据。</small></div>
        <div className="task-editor-section-heading"><h3>按序阶段</h3><span>{draft.checkpoints.length} / 5 阶段 · {conditionCount} / 20 条件</span></div>
        {draft.checkpoints.map((stage, index) => <section className="task-editor-stage" key={stage.id} data-stage-id={stage.id} aria-label={`阶段${index + 1}`}>
          <div className="task-editor-stage-heading"><label className="task-editor-field">阶段 {index + 1}<input aria-label={`阶段${index + 1}名称`} maxLength={256} value={stage.title}
            onChange={event => edit({ ...draft, checkpoints: draft.checkpoints.map(item => item.id === stage.id ? { ...item, title: event.target.value } : item) })} /></label>
            <button type="button" aria-label={`阶段${index + 1}上移`} disabled={index === 0} onClick={() => {
              const stages = [...draft.checkpoints]; [stages[index - 1], stages[index]] = [stages[index], stages[index - 1]]; edit({ ...draft, checkpoints: stages });
            }}>上移</button>
            <button type="button" aria-label={`阶段${index + 1}下移`} disabled={index === draft.checkpoints.length - 1} onClick={() => {
              const stages = [...draft.checkpoints]; [stages[index + 1], stages[index]] = [stages[index], stages[index + 1]]; edit({ ...draft, checkpoints: stages });
            }}>下移</button>
            <button type="button" aria-label={`删除阶段${index + 1}`} onClick={() => edit({ ...draft, checkpoints: draft.checkpoints.filter(item => item.id !== stage.id) })}>删除阶段</button>
            <button type="button" data-task-action="save-stage-fragment" aria-label={`阶段${index + 1}存为片段`} disabled={!canSaveFragment || Boolean(pending)}
              onClick={() => beginFragment("stage", stage.id)}>存为片段</button>
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
