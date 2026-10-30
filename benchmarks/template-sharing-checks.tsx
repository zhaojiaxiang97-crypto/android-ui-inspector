import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { DebugTaskEditor, type DebugTaskEditorApi } from "../src/features/automation/DebugTaskEditor";
import { selectorFields } from "../src/features/automation/debug-task-editor-model";
import { debugTaskDefinition, type DebugTaskCondition, type DebugTaskDefinition } from "../shared/debug-task";
import { debugTaskFragmentSaveInput, debugTaskTemplateSaveInput, type DebugTaskFragment, type DebugTaskFragmentSaveInput,
  type DebugTaskTemplate, type DebugTaskTemplateImportResult, type DebugTaskTemplateExportResult } from "../shared/debug-task-templates";
import type { UiSnapshot } from "../shared/types";
import { makeNode } from "./fixtures";
import dynamicTask from "../tests/fixtures/sample-dynamic-task.json";
import "../src/styles/tokens.css";
import "../src/App.css";
import "../src/styles/entry.css";

function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const equal = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const wait = async (condition: () => boolean, message: string) => {
  const deadline = performance.now() + 5000;
  while (!condition()) { if (performance.now() > deadline) throw Error(message); await new Promise(resolve => setTimeout(resolve, 10)); }
};
const fullDefinition = debugTaskDefinition.parse(dynamicTask);
const firstId = "11111111-1111-4111-8111-111111111111";
const now = "2026-10-12T01:00:00Z";
function fixture(): UiSnapshot {
  const root = makeNode("root"), node = makeNode("target", 1);
  root.text = root.resourceId = root.contentDesc = null; node.text = "RED CHILD"; root.children = [node];
  return { serial: "local-fixture", root, nodeCount: 2, xmlSize: 0, rawXml: null, screenshotDataUrl: null, error: null, warning: null };
}
class SharingApi implements DebugTaskEditorApi {
  templates: DebugTaskTemplate[] = [{ id: firstId, name: "动态页面完整检查", definition: fullDefinition, createdAt: now, updatedAt: now }];
  fragments: DebugTaskFragment[] = [];
  loadError: string | null = null;
  importMode: "cancel" | "error" | "success" = "cancel";
  exportMode: "cancel" | "error" | "success" = "cancel";
  saves = 0; imports = 0; exports = 0; sessionRequests = 0;
  result() { return { templates: structuredClone(this.templates), error: null }; }
  fragmentResult() { return { fragments: structuredClone(this.fragments), error: null }; }
  async loadDebugTaskTemplates() { return this.loadError ? { templates: [], error: this.loadError } : this.result(); }
  async loadDebugTaskFragments() { return this.loadError ? { fragments: [], error: this.loadError } : this.fragmentResult(); }
  async saveDebugTaskTemplate(raw: Parameters<DebugTaskEditorApi["saveDebugTaskTemplate"]>[0]) {
    const input = debugTaskTemplateSaveInput.parse(raw), previous = this.templates.find(item => item.id === input.id);
    const value = { id: input.id ?? crypto.randomUUID(), name: input.name, definition: input.definition, createdAt: previous?.createdAt ?? now, updatedAt: now };
    this.templates = previous ? this.templates.map(item => item.id === value.id ? value : item) : [...this.templates, value];
    return this.result();
  }
  async deleteDebugTaskTemplate(id: string) { this.templates = this.templates.filter(item => item.id !== id); return this.result(); }
  async saveDebugTaskFragment(raw: DebugTaskFragmentSaveInput) {
    const input = debugTaskFragmentSaveInput.parse(raw);
    if (this.fragments.some(item => item.name === input.name)) return { fragments: [], error: "片段名已存在；已有片段未替换。" };
    this.saves++; this.fragments.push({ ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now }); return this.fragmentResult();
  }
  async deleteDebugTaskFragment(id: string) { this.fragments = this.fragments.filter(item => item.id !== id); return this.fragmentResult(); }
  async importDebugTaskTemplates(): Promise<DebugTaskTemplateImportResult> {
    this.imports++;
    const base = { canceled: this.importMode === "cancel", filePath: this.importMode === "cancel" ? null : "/本地/共享模板.json", templates: [], fragments: [],
      imported: { templates: 0, fragments: 0 }, skipped: { templates: [], fragments: [] }, error: null };
    if (this.importMode === "cancel") return base;
    if (this.importMode === "error") return { ...base, error: "导入文件内容无效；本机库和草稿已保留。" };
    this.templates.push({ id: crypto.randomUUID(), name: "导入的离线模板", definition: fullDefinition, createdAt: now, updatedAt: now });
    this.fragments.push({ id: crypto.randomUUID(), name: "导入的条件", kind: "condition", condition: fullDefinition.finalConditions[0], createdAt: now, updatedAt: now });
    return { ...base, ...this.result(), fragments: structuredClone(this.fragments), imported: { templates: 1, fragments: 1 }, skipped: { templates: ["动态页面完整检查"], fragments: [] } };
  }
  async exportDebugTaskTemplates(): Promise<DebugTaskTemplateExportResult> {
    this.exports++;
    return { canceled: this.exportMode === "cancel", filePath: this.exportMode === "cancel" ? null : "/本地/共享模板.json",
      templateCount: this.templates.length, fragmentCount: this.fragments.length,
      error: this.exportMode === "error" ? "导出目标已被修改；原文件已保留。" : null };
  }
  async defineDebugTask(): Promise<Record<string, unknown>> { this.sessionRequests++; throw Error("offline editor requested authorization"); }
  async checkDebugTask(): Promise<Record<string, unknown>> { this.sessionRequests++; throw Error("offline editor requested a device check"); }
}

async function verifyTemplateSharing() {
  const api = new SharingApi(), host = document.createElement("div"), checks: string[] = [];
  document.body.append(host); const root = createRoot(host);
  let open = true, snapshot: UiSnapshot | null = fixture(), currentApi: DebugTaskEditorApi = api;
  const draw = () => flushSync(() => root.render(<><button id="open-editor" onClick={() => { open = true; draw(); }}>打开任务编辑器</button>
    {open && <DebugTaskEditor snapshot={snapshot} selectedNode={snapshot?.root?.children[0] ?? null} state={null} api={currentApi}
      onClose={() => { open = false; draw(); }} />}</>));
  const action = (name: string) => document.querySelector<HTMLButtonElement>(`[data-task-action="${name}"]`)!;
  const field = (name: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-task-field="${name}"]`)!;
  const fill = (name: string, value: string) => {
    const element = field(name), prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    flushSync(() => { Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
  };
  const click = (name: string) => flushSync(() => action(name).click());
  const text = () => document.querySelector(".debug-task-editor")?.textContent ?? "";
  const settled = async () => { await new Promise(resolve => setTimeout(resolve, 10));
    await wait(() => !document.querySelector('[role="status"]')?.textContent?.startsWith("正在"), "sharing request did not settle"); };
  const load = () => { fill("template-list", firstId); click("load"); };
  const condition = (element: Element): DebugTaskCondition => ({ id: element.getAttribute("data-condition-id")!,
    state: element.querySelector("select")!.value as DebugTaskCondition["state"],
    selector: Object.fromEntries(selectorFields.map(({ key }) => [key, element.querySelector<HTMLInputElement>(`[data-task-field="${key}"]`)!.value]).filter(([, value]) => value !== "")) });
  const draft = (): DebugTaskDefinition => ({ goal: field("goal").value,
    checkpoints: Array.from(document.querySelectorAll(".task-editor-stage")).map(stage => ({ id: stage.getAttribute("data-stage-id")!,
      title: stage.querySelector<HTMLInputElement>(".task-editor-stage-heading input")!.value,
      conditions: Array.from(stage.querySelectorAll(".task-editor-condition")).map(condition) })),
    finalConditions: Array.from(document.querySelectorAll(".task-editor-final .task-editor-condition")).map(condition) });
  const total = () => document.querySelectorAll(".task-editor-condition").length;
  draw(); await settled(); load();
  assert(equal(draft(), fullDefinition) && api.sessionRequests === 0 && api.imports === 0 && api.exports === 0, "opening sharing UI changed the task or started actions");
  assert(action("define").disabled, "offline sharing enabled authorization"); checks.push("离线打开不导入、不授权、不操作设备");

  click("save-condition-fragment");
  assert(document.activeElement === field("fragment-name"), "saving a fragment did not focus its name field");
  fill("fragment-name", "RED 可操作条件"); click("fragment-save"); await settled();
  const savedCondition = api.fragments[0];
  assert(savedCondition?.kind === "condition" && equal(savedCondition.condition, fullDefinition.checkpoints[0].conditions[0]) && equal(draft(), fullDefinition), "saving a condition changed exact properties or draft");
  checks.push("单条件命名保存，状态和精确属性保留");
  click("fragment-insert"); click("fragment-insert");
  const inserted = draft().finalConditions.slice(-2);
  assert(total() === 8 && inserted[0].id !== inserted[1].id && inserted.every(item => item.id !== savedCondition.condition.id
    && equal({ ...item, id: savedCondition.condition.id }, savedCondition.condition)), "repeat condition insertion changed properties or reused IDs");
  fill("fragment-target", "ready"); click("fragment-insert");
  assert(total() === 9 && draft().checkpoints[0].conditions.length === 4, "condition target did not select the existing stage"); checks.push("重复插入新编号，可选择阶段或最终条件");
  click("save-stage-fragment"); fill("fragment-name", "初始页面完整阶段"); click("fragment-save"); await settled();
  const savedStage = api.fragments.find(item => item.kind === "stage")!;
  assert(savedStage.kind === "stage" && savedStage.stage.conditions.length === 4 && field("fragment-target").disabled, "stage fragment lost conditions or accepted condition target");
  click("fragment-insert"); click("fragment-insert");
  const expanded = draft(), conditionIds = [...expanded.finalConditions, ...expanded.checkpoints.flatMap(stage => stage.conditions)].map(item => item.id);
  assert(total() === 17 && expanded.checkpoints.length === 3 && new Set(conditionIds).size === conditionIds.length
    && new Set(expanded.checkpoints.map(stage => stage.id)).size === 3, "stage insertion reused identifiers");
  assert(expanded.checkpoints.slice(1).every(stage => equal(stage.conditions.map(({ id: _id, ...item }) => item),
    savedStage.kind === "stage" ? savedStage.stage.conditions.map(({ id: _id, ...item }) => item) : [])), "stage insertion changed order or state");
  checks.push("完整阶段重复插入，全部编号独立且顺序保留");
  click("fragment-insert");
  assert(equal(draft(), expanded) && document.querySelector('[role="alert"]')?.textContent?.includes("20"), "limit rejection changed the draft"); checks.push("超出条件上限明确拒绝并保留草稿");
  click("fragment-delete"); await settled();
  assert(equal(draft(), expanded) && api.fragments.every(item => item.id !== savedStage.id), "fragment deletion removed inserted conditions"); checks.push("删除库片段不改已插入草稿");
  const saveCount = api.saves;
  click("save-condition-fragment"); fill("fragment-name", "取消的片段"); click("fragment-cancel-save");
  assert(api.saves === saveCount && equal(draft(), expanded) && !document.querySelector('[data-task-field="fragment-name"]'), "cancel save changed the draft or called storage"); checks.push("取消命名保存不写入");
  click("save-condition-fragment"); fill("fragment-name", "RED 可操作条件"); click("fragment-save"); await settled();
  assert(document.querySelector('[role="alert"]')?.textContent?.includes("片段名已存在") && field("fragment-name").value === "RED 可操作条件"
    && api.saves === saveCount && equal(draft(), expanded), "same-name save error replaced content or closed the name form");
  click("fragment-cancel-save"); checks.push("片段同名冲突保留草稿及名称表单");

  const libraryBefore = canonical({ templates: api.templates, fragments: api.fragments });
  click("import"); await settled(); assert(text().includes("已取消导入"), "cancel import was reported as success");
  click("export"); await settled(); assert(text().includes("已取消导出") && equal(draft(), expanded)
    && canonical({ templates: api.templates, fragments: api.fragments }) === libraryBefore, "cancel sharing changed draft or library"); checks.push("导入和导出取消保留库及草稿");
  api.importMode = api.exportMode = "error";
  click("import"); await settled(); assert(document.querySelector('[role="alert"]')?.textContent?.includes("内容无效"), "invalid import hid its error");
  click("export"); await settled(); assert(document.querySelector('[role="alert"]')?.textContent?.includes("原文件已保留") && equal(draft(), expanded)
    && canonical({ templates: api.templates, fragments: api.fragments }) === libraryBefore, "sharing error changed draft or library"); checks.push("损坏导入和导出冲突显示错误并保留编辑");
  api.importMode = api.exportMode = "success";
  click("import"); await settled();
  assert(text().includes("本机同名内容已保留") && api.templates.length === 2 && api.fragments.length === 2 && equal(draft(), expanded), "successful import replaced draft or hid same-name skips");
  click("export"); await settled(); assert(text().includes("已导出 2 份模板、2 份片段") && api.sessionRequests === 0, "export did not report saved data or requested a session");
  checks.push("导入仅更新库，同名保留明确显示；导出报告数量");

  open = false; draw(); snapshot = null;
  currentApi = { loadDebugTaskTemplates: () => api.loadDebugTaskTemplates(), saveDebugTaskTemplate: input => api.saveDebugTaskTemplate(input),
    deleteDebugTaskTemplate: id => api.deleteDebugTaskTemplate(id), defineDebugTask: () => api.defineDebugTask(), checkDebugTask: () => api.checkDebugTask() };
  open = true; draw(); await settled();
  assert(action("import").disabled && action("export").disabled && action("show-fragments").disabled
    && action("save-condition-fragment").disabled && text().includes("对应按钮不可用"), "legacy API silently accepted sharing operations"); checks.push("旧接口缺共享能力时控件禁用并说明");
  click("close"); const opener = document.getElementById("open-editor")!; opener.focus(); opener.click(); await settled();
  document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
  assert(!document.querySelector("dialog") && document.activeElement === opener, "dialog cancel did not close and restore focus"); checks.push("键盘取消语义关闭并恢复入口焦点");

  if (savedStage.kind === "stage") api.fragments.push(structuredClone(savedStage));
  Object.assign(window, { setTemplateSharingVisualState: async (mode: "templates" | "fragments" | "error") => {
    open = false; draw(); currentApi = api; snapshot = mode === "error" ? null : fixture();
    api.loadError = mode === "error" ? "无法读取任务模板；文件内容无效，原文件已保留。" : null;
    open = true; draw(); await settled();
    if (mode !== "error") load();
    if (mode === "fragments") { click("show-fragments"); fill("fragment-list", savedStage.id); click("save-condition-fragment"); fill("fragment-name", "可复用的精确页面条件"); }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  } });
  return { passed: true, checks, sessionRequests: api.sessionRequests };
}
Object.assign(window, { verifyTemplateSharing });
