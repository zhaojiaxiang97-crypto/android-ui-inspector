import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { makeNode } from "./fixtures";
import type { UiNode, UiSnapshot } from "../shared/types";
import { SelectorMatchDiagnostics } from "../src/features/automation/SelectorMatchDiagnostics";
import { uniqueSnapshotNode, type DebugSelector } from "../src/features/automation/selector-match-diagnostics";
import "../src/styles/tokens.css";
import "../src/features/automation/debug-task-editor.css";
import "./selector-match-diagnostics-checks.css";

const assert = (value: unknown, message: string) => { if (!value) throw Error(message); };
const painted = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
type VisualState = "one" | "multiple" | "reference" | "none" | "empty" | "no-tree" | "error" | "duplicate-id" | "invalid-bounds" | "old" | "many";
function candidate(id: string, text = " READY "): UiNode {
  return { ...makeNode(id, 1), package: "com.example.sample", resourceId: "com.example.sample:id/ready", text,
    contentDesc: "准备完成", bounds: { left: 32, top: 180, right: 328, bottom: 232, raw: "[32,180][328,232]" } };
}
function fixture(): UiSnapshot {
  const root = { ...makeNode("root"), package: "com.example.sample", text: null, contentDesc: null, resourceId: null, children: [candidate("ready")] };
  return { serial: "local-fixture", root, nodeCount: 2, rawXml: null, xmlSize: 0, screenshotDataUrl: null, error: null, warning: null, inspectionSource: "debug-view" };
}
const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
let snapshot: UiSnapshot | null = null, selector: DebugSelector = {}, generation = 0, callbackCount = 0;
let selected: UiNode | null = null, callbackSnapshot: UiSnapshot | null = null;
function acceptSelection(nodeId: string, sourceSnapshot: UiSnapshot) {
  if (sourceSnapshot !== snapshot) return false;
  const node = uniqueSnapshotNode(snapshot, nodeId); if (!node) return false;
  selected = node; callbackSnapshot = sourceSnapshot; callbackCount++; draw(); return true;
}
function draw() {
  flushSync(() => root.render(<main className="debug-task-editor selector-check-workspace">
    <h2>检查任务 · 精确条件</h2><p>对照工作台中的现有控件，调整需要验收的精确属性。</p>
    <fieldset className="task-editor-condition"><legend>最终条件 · 可见</legend>
      <div className="task-editor-selector-fields">{(["resourceId", "text", "contentDesc", "className"] as const).map((field, index) => <label key={field}>
        {["资源 ID", "文字", "描述", "类名"][index]}<input aria-label={field} value={selector[field] ?? ""} readOnly />
      </label>)}</div>
      <SelectorMatchDiagnostics key={generation} snapshot={snapshot} selector={selector} onSelectMatch={acceptSelection} />
    </fieldset>
    <p className="selector-check-selection" role="status">{selected ? `已定位控件：${selected.id}` : "选择精确结果可查看工作台中的对应控件。"}</p>
  </main>));
}
async function setup(state: VisualState) {
  snapshot = fixture(); selector = { resourceId: "com.example.sample:id/ready", text: " READY " };
  generation++; callbackCount = 0; selected = null; callbackSnapshot = null;
  switch (state) {
    case "multiple": selector = { resourceId: "com.example.sample:id/ready" }; snapshot.root!.children.push(candidate("ready-2", "进行中")); snapshot.nodeCount++; break;
    case "reference": selector = { resourceId: "com.example.sample:id/ready", text: "READY", contentDesc: "准备中", className: "android.widget.Button" }; break;
    case "none": selector = { text: "完全不同的结果" }; break;
    case "empty": selector = {}; break;
    case "no-tree": snapshot = null; break;
    case "error": snapshot.root!.children[0].bounds!.right = Number.NaN; break;
    case "duplicate-id": snapshot.root!.id = "ready"; break;
    case "invalid-bounds": snapshot.root!.children[0].bounds!.bottom = 180; break;
    case "old": delete snapshot.inspectionSource; break;
    case "many": selector = { resourceId: "com.example.sample:id/ready" }; snapshot.root!.children = Array.from({ length: 100 }, (_, i) => candidate(`list-${i}`, ` READY ${i} `)); snapshot.nodeCount = 101; break;
  }
  draw(); await painted();
}
function diagnostics() { return document.querySelector<HTMLDetailsElement>("[data-selector-diagnostic]")!; }
function action() { return document.querySelector<HTMLButtonElement>('[data-selector-action="select"]'); }

async function verify() {
  const checks: string[] = [];
  await setup("one"); assert(!diagnostics().open, "diagnostics expanded by default"); checks.push("详情默认折叠");
  diagnostics().open = true; action()!.click(); await painted();
  assert(callbackCount === 1 && selected === snapshot!.root!.children[0] && callbackSnapshot === snapshot, "selection lost original snapshot or node"); checks.push("选择传原快照对象");
  await setup("reference"); diagnostics().open = true;
  assert(!action() && diagnostics().textContent?.includes("文字不匹配") && diagnostics().textContent?.includes("类名不匹配"), "reference could navigate or lost mismatch details"); checks.push("近似候选无定位按钮");
  await setup("duplicate-id"); assert(action()?.disabled, "duplicate node ID enabled navigation"); checks.push("重复编号禁用定位");
  await setup("invalid-bounds"); assert(action()?.disabled, "invalid geometry enabled navigation"); checks.push("损坏位置禁用定位");
  await setup("one"); diagnostics().open = true;
  snapshot!.root!.children[0].text = "CHANGED"; action()!.click(); await painted();
  assert(callbackCount === 0 && diagnostics().textContent?.includes("控件记录已变化"), "cached exact candidate was not rechecked"); checks.push("点击重查精确条件");
  await setup("one"); diagnostics().open = true;
  snapshot!.root!.children.push(candidate("ready", "OTHER")); snapshot!.nodeCount++; action()!.click(); await painted();
  assert(callbackCount === 0, "new ID collision was not rechecked"); checks.push("点击重查全树编号唯一");
  await setup("one"); diagnostics().open = true;
  const oldSnapshot = snapshot!, staleButton = action()!, oldReferenceCount = callbackCount;
  snapshot = fixture(); generation++; draw(); await painted(); staleButton.click(); await painted();
  assert(callbackCount === oldReferenceCount, "detached old-snapshot button triggered navigation");
  assert(!acceptSelection("ready", oldSnapshot) && callbackCount === 0, "parent allowed stale snapshot reference");
  action()!.click(); await painted();
  assert(callbackCount === 1 && callbackSnapshot === snapshot, "new snapshot selection did not use current object"); checks.push("切换快照拒绝旧引用");
  await setup("many"); diagnostics().open = true;
  assert(document.querySelectorAll('[data-selector-match="exact"]').length === 20 && diagnostics().textContent?.includes("共 100 个"), "large candidate display exceeded cap or lost total"); checks.push("结果列表上限与完整计数");
  return { passed: true, checks };
}

Object.assign(window, { selectorDiagnosticChecks: {
  verify, setup, painted,
  expand: async () => { diagnostics().open = true; await painted(); },
  focusSummary: () => { diagnostics().querySelector<HTMLElement>("summary")!.focus(); },
  focusAction: () => { action()!.focus(); },
  result: () => ({ open: diagnostics().open, callbackCount, sourceIsCurrent: callbackSnapshot === snapshot, selected: selected?.id ?? null }),
  layout: () => {
    const panel = document.querySelector<HTMLElement>(".selector-check-workspace")!, details = diagnostics();
    const lists = [...document.querySelectorAll<HTMLElement>(".selector-candidate-list")];
    const enabled = [...document.querySelectorAll<HTMLButtonElement>('[data-selector-action="select"]')].filter(button => !button.disabled);
    const alert = details.querySelector<HTMLElement>('[role="alert"]');
    return { fitsWidth: panel.scrollWidth <= panel.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1,
      detailsFits: details.scrollWidth <= details.clientWidth + 1, listsFit: lists.every(list => list.scrollWidth <= list.clientWidth + 1),
      exactCount: details.querySelectorAll('[data-selector-match="exact"]').length,
      referenceCount: details.querySelectorAll('[data-selector-match="reference"]').length,
      enabledButtons: enabled.length, open: details.open, status: details.dataset.selectorDiagnostic,
      body: details.textContent, alertColor: alert ? getComputedStyle(alert).color : null,
      focusVisible: document.activeElement?.matches(":focus-visible") ?? false };
  },
} });
void setup("one");
