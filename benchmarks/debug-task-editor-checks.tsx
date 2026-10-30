import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { makeNode } from "./fixtures";
import { DebugTaskEditor, type DebugTaskEditorApi } from "../src/features/automation/DebugTaskEditor";
import { debugTaskDefinition, type DebugTaskDefinition } from "../shared/debug-task";
import { debugTaskTemplateSaveInput, type DebugTaskTemplate, type DebugTaskTemplatesResult } from "../shared/debug-task-templates";
import type { DebugSessionState, UiSnapshot } from "../shared/types";
import dynamicTask from "../tests/fixtures/sample-dynamic-task.json";
import "../src/styles/tokens.css";
import "../src/App.css";
import "../src/styles/entry.css";

const assert = (value: unknown, message: string) => { if (!value) throw Error(message); };
const wait = async (condition: () => boolean, message: string) => {
  const deadline = performance.now() + 5000;
  while (!condition()) { if (performance.now() > deadline) throw Error(message); await new Promise(resolve => setTimeout(resolve, 10)); }
};
const fullDefinition = debugTaskDefinition.parse(dynamicTask);
const firstId = "11111111-1111-4111-8111-111111111111", oldId = "22222222-2222-4222-8222-222222222222";
function session(): DebugSessionState { return { id: crypto.randomUUID(), serial: "local-fixture", packageName: "com.example.sample", active: true,
  busy: false, expiresAt: new Date(Date.now() + 60_000).toISOString(), steps: [], evidencePath: null }; }
function fixture(): UiSnapshot {
  const root = makeNode("root"), target = makeNode("target", 1);
  root.text = root.resourceId = root.contentDesc = null;
  target.text = " RED CHILD "; target.resourceId = "com.example.sample:id/red"; target.contentDesc = " red label "; root.children = [target];
  return { serial: "local-fixture", root, nodeCount: 2, xmlSize: 0, rawXml: null, screenshotDataUrl: null, error: null, warning: null };
}
class EditorApi implements DebugTaskEditorApi {
  templates: DebugTaskTemplate[] = [
    { id: firstId, name: "动态页面完整检查", createdAt: "2026-10-12T01:00:00Z", updatedAt: "2026-10-12T01:00:00Z", definition: fullDefinition },
    { id: oldId, name: "旧模板：完成状态", createdAt: "2026-10-12T01:00:00Z", updatedAt: "2026-10-12T01:00:00Z",
      definition: debugTaskDefinition.parse({ goal: "完成页面", finalConditions: [{ id: "done", state: "visible", selector: { text: "DONE" } }] }) },
  ];
  saves: DebugTaskDefinition[] = [];
  definitions: { sessionId: string; definition: DebugTaskDefinition }[] = [];
  checks: { sessionId: string; taskId: string; checkpointId?: string }[] = [];
  loadError: string | null = null; saveError: string | null = null; checkError: string | null = null;
  deferredCheck: ((result: Record<string, unknown>) => void) | null = null;
  deferCheck = false;
  state: DebugSessionState | null = null;
  onState: ((state: DebugSessionState) => void) | null = null;
  result(error: string | null = null): DebugTaskTemplatesResult { return { templates: error ? [] : structuredClone(this.templates), error }; }
  async loadDebugTaskTemplates() { return this.result(this.loadError); }
  async saveDebugTaskTemplate(raw: Parameters<DebugTaskEditorApi["saveDebugTaskTemplate"]>[0]) {
    if (this.saveError) return this.result(this.saveError);
    const input = debugTaskTemplateSaveInput.parse(raw);
    if (this.templates.some(item => item.name === input.name && item.id !== input.id)) return this.result("模板名已存在");
    this.saves.push(input.definition);
    const previous = this.templates.find(item => item.id === input.id), now = new Date().toISOString();
    const value = { id: input.id ?? crypto.randomUUID(), name: input.name, definition: input.definition, createdAt: previous?.createdAt ?? now, updatedAt: now };
    this.templates = previous ? this.templates.map(item => item.id === value.id ? value : item) : [...this.templates, value];
    return this.result();
  }
  async deleteDebugTaskTemplate(id: string) { this.templates = this.templates.filter(item => item.id !== id); return this.result(); }
  async defineDebugTask(input: Parameters<DebugTaskEditorApi["defineDebugTask"]>[0]) {
    this.definitions.push(structuredClone(input));
    assert(input.sessionId === this.state?.id && this.state.active, "definition used an unauthorized session");
    const task = { id: crypto.randomUUID(), definition: debugTaskDefinition.parse(input.definition), definedAt: new Date().toISOString(), definedStepId: 1, checks: [] };
    await Promise.resolve(); this.onState?.({ ...this.state!, task });
    return { message: "任务已固定到当前会话。", taskId: task.id };
  }
  async checkDebugTask(input: Parameters<DebugTaskEditorApi["checkDebugTask"]>[0]): Promise<Record<string, unknown>> {
    this.checks.push(structuredClone(input));
    assert(input.sessionId === this.state?.id && input.taskId === this.state.task?.id && this.state.active, "check used a stale task");
    if (this.deferCheck) { this.deferCheck = false; return new Promise(resolve => { this.deferredCheck = resolve; }); }
    if (this.checkError) return { isError: true, message: this.checkError };
    const task = this.state!.task!;
    const result = { taskId: task.id, checkpointId: input.checkpointId ?? null, stepId: 2, checkedAt: new Date().toISOString(),
      status: "insufficient_evidence" as const, reason: "本地检查未连接设备；没有新的页面观察。", observations: { first: null, second: null }, conditions: [] };
    await Promise.resolve(); this.onState?.({ ...this.state!, task: { ...task, checks: [result] } });
    return { taskResult: result, message: "验收证据不足。" };
  }
}

async function verifyDebugTaskEditor() {
  const api = new EditorApi(), host = document.createElement("div"), checks: string[] = [];
  document.body.append(host); const root = createRoot(host);
  let open = true, snapshot: UiSnapshot | null = fixture(), state: DebugSessionState | null = null;
  let selectedNode = snapshot.root!.children[0];
  const draw = () => flushSync(() => root.render(<><button id="open-editor" onClick={() => { open = true; draw(); }}>打开任务编辑器</button>
    {open && <DebugTaskEditor snapshot={snapshot} selectedNode={snapshot ? selectedNode : null} state={state} api={api}
      onClose={() => { open = false; draw(); }} />}</>));
  api.onState = next => { state = next; api.state = next; draw(); };
  const action = (name: string) => document.querySelector<HTMLButtonElement>(`[data-task-action="${name}"]`)!;
  const field = (name: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-task-field="${name}"]`)!;
  const fill = (name: string, value: string) => {
    const element = field(name), prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    flushSync(() => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
  };
  const click = (name: string) => flushSync(() => action(name).click());
  const clickLabel = (label: string) => flushSync(() => Array.from(document.querySelectorAll<HTMLButtonElement>(".debug-task-editor button")).find(button => button.getAttribute("aria-label") === label || button.textContent === label)!.click());
  const settled = async () => { await new Promise(resolve => setTimeout(resolve, 10)); await wait(() => !action("refresh")?.disabled, "editor request did not settle"); };
  const load = (id: string) => { fill("template-list", id); click("load"); };
  const text = () => document.querySelector(".debug-task-editor")?.textContent ?? "";
  draw(); await settled();
  assert(action("define").disabled && api.definitions.length === 0 && api.checks.length === 0, "offline editor started a session request"); checks.push("离线编辑不授权");
  load(firstId);
  assert(field("goal").value === fullDefinition.goal && document.querySelectorAll(".task-editor-condition").length === 6,
    `full template lost conditions: ${JSON.stringify({ goal: field("goal").value, count: document.querySelectorAll(".task-editor-condition").length, selected: field("template-list").value, disabled: action("load").disabled })}`);
  assert(document.querySelector<HTMLSelectElement>('[aria-label="阶段1条件1状态"]')?.value === "enabled", "restored condition state changed");
  clickLabel("添加阶段"); assert(document.querySelectorAll(".task-editor-stage").length === 2, "stage could not be added");
  clickLabel("阶段2上移"); assert(document.querySelector<HTMLInputElement>('[aria-label="阶段1名称"]')?.value === "阶段 2", "stage order did not change");
  clickLabel("删除阶段1"); assert(document.querySelectorAll(".task-editor-stage").length === 1, "stage could not be removed");
  clickLabel("添加最终条件"); assert(document.querySelectorAll(".task-editor-condition").length === 7, "condition could not be added");
  const conditionState = document.querySelector<HTMLSelectElement>('[aria-label="最终条件4状态"]')!;
  flushSync(() => { conditionState.value = "disabled"; conditionState.dispatchEvent(new Event("change", { bubbles: true })); });
  assert(conditionState.value === "disabled", "disabled condition was not editable");
  clickLabel("删除最终条件4"); checks.push("阶段排序和条件增删");
  fill("goal", "修改目标但保留六个条件"); click("save"); await settled();
  assert(api.saves.at(-1)?.checkpoints[0].conditions.length === 3 && api.saves.at(-1)?.finalConditions.length === 3, "saving lost conditions"); checks.push("六条件完整恢复与更新");
  click("close"); open = true; draw(); await settled(); load(firstId);
  assert(field("goal").value === "修改目标但保留六个条件", "reopened template was not updated"); checks.push("关闭后恢复编辑");
  fill("name", "完整检查副本"); click("save-as-new"); await settled();
  assert(api.templates.some(item => item.name === "完整检查副本" && item.id !== firstId && item.definition.finalConditions.length === 3), "save-as-new replaced original template"); checks.push("完整模板另存副本");
  click("new"); fill("goal", "确认当前控件可见"); fill("name", "精确属性模板"); click("use-selected-node");
  assert(field("text").value === " RED CHILD " && field("resourceId").value === "com.example.sample:id/red" && field("contentDesc").value === " red label ", "selected node was not exact");
  click("save"); await settled(); const generated = api.templates.find(item => item.name === "精确属性模板")!;
  assert(generated.definition.finalConditions[0].selector.text === " RED CHILD ", "saved selector trimmed exact text"); checks.push("选中控件精确属性");
  load(oldId); assert(document.querySelectorAll(".task-editor-stage").length === 0 && field("goal").value === "完成页面", "old template not reusable"); checks.push("旧模板缺阶段可读");
  click("new"); snapshot = null; draw(); fill("goal", "离线手写条件"); fill("name", "离线模板"); fill("text", "DONE");
  assert(action("use-selected-node").disabled, "empty snapshot enabled node generation"); click("save"); await settled(); checks.push("空控件离线手写保存");
  const count = api.templates.length; api.saveError = "模板文件已损坏；原文件已保留。";
  fill("goal", "失败时保留草稿"); click("save"); await settled();
  assert(text().includes("模板文件已损坏") && field("goal").value === "失败时保留草稿" && (field("template-list") as HTMLSelectElement).options.length === count + 1, "save error discarded draft or templates");
  api.loadError = "无法读取模板，原文件已保留。"; click("refresh"); await settled();
  assert(text().includes("无法读取模板") && field("goal").value === "失败时保留草稿", "load error discarded draft"); checks.push("读写失败保留草稿和列表");
  api.loadError = api.saveError = null;
  load(generated.id); click("delete"); await settled();
  assert(!api.templates.some(item => item.id === generated.id) && field("goal").value === generated.definition.goal, "deletion discarded active draft"); checks.push("删除模板保留编辑");
  state = session(); api.state = state; draw();
  assert(!action("define").disabled, "authorized session cannot define valid task"); click("define"); await settled();
  assert(api.definitions.length === 1 && api.definitions[0].sessionId === state.id && state.task, "definition did not use current authorization");
  fill("goal", "编辑草稿不能改会话目标"); assert(action("define").disabled && state.task?.definition.goal === generated.definition.goal, "fixed task was rewritten locally"); checks.push("当前授权定义且不能重写");
  click("check"); await settled(); assert(api.checks.length === 1 && api.checks[0].taskId === state.task?.id && text().includes("当时证据不足"), "checker used local preview as evidence"); checks.push("显式验收使用固定任务");
  api.checkError = "采集失败，不能判定通过。"; click("check"); await settled();
  assert(document.querySelector('[role="alert"]')?.textContent?.includes("采集失败"), "session error was hidden"); api.checkError = null; checks.push("会话错误显示");
  state = { ...state, busy: true }; api.state = state; draw(); assert(action("check").disabled, "busy session accepted check");
  state = { ...state, busy: false, expiresAt: new Date(Date.now() - 10_000).toISOString() }; api.state = state; draw(); assert(action("check").disabled, "expired session accepted check"); checks.push("繁忙和过期会话禁用");
  state = { ...session(), task: state.task }; api.state = state; draw(); api.deferCheck = true; click("check");
  await wait(() => Boolean(api.deferredCheck), "late check was not pending"); state = session(); api.state = state; draw();
  api.deferredCheck!({ message: "旧会话验收通过" }); api.deferredCheck = null; await settled();
  assert(text().includes("会话已结束或切换") && !text().includes("旧会话验收通过") && !state.task, "old request leaked into new session"); checks.push("迟到验收与会话切换守卫");
  click("close"); const opener = document.getElementById("open-editor")!; opener.focus(); opener.click(); await settled();
  document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
  assert(!document.querySelector("dialog") && document.activeElement === opener, "Escape-style cancel did not close and restore focus"); checks.push("原生取消与焦点恢复");

  Object.assign(window, { setDebugTaskEditorVisualState: async (mode: "selected" | "empty" | "error") => {
    open = false; draw(); snapshot = mode === "selected" ? fixture() : null;
    if (snapshot) selectedNode = snapshot.root!.children[0];
    state = mode === "selected" ? { ...session(), task: { id: crypto.randomUUID(), definedAt: new Date().toISOString(), definedStepId: 1, definition: fullDefinition, checks: [] } } : null;
    api.state = state; api.loadError = mode === "error" ? "无法读取任务模板；文件内容无效，原文件已保留。" : null;
    open = true; draw(); await settled();
    if (mode === "selected") load(firstId);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  } });
  return { passed: true, checks };
}
Object.assign(window, { verifyDebugTaskEditor });
