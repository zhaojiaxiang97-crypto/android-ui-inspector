import { useCallback, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { TestReportPanel } from "../src/features/reports/TestReportPanel";
import { DebugTaskRunComparison } from "../src/features/reports/DebugTaskRunComparison";
import type { DebugReportExportImportResult, DebugReportExportRequest, DebugReportExportResult } from "../shared/debug-report-export";
import type { ImportTestReportResult, LoadedTestReport } from "../shared/test-report";
import "../src/styles/tokens.css";
import "../src/App.css";
import "../src/styles/workbench.css";

type Cases = Record<"primary" | "same" | "mismatch" | "missing" | "unchecked" | "stageFinal" | "noTask", LoadedTestReport>;
type Mode = keyof Cases | "pending" | "canceled" | "failed" | "throw";
let cases: Cases, mode: Mode = "same", key = 0, sourceId = "primary-export-source", nextPrimary: LoadedTestReport;
let finishPending: ((result: ImportTestReportResult) => void) | null = null;
let setOpen: (value: boolean) => void = () => {}, finishExport: ((result: DebugReportExportResult) => void) | null = null;
const host = document.createElement("main"); document.body.append(host); const root = createRoot(host);
const exportRequests: DebugReportExportRequest[] = [];
const result = (report: LoadedTestReport): ImportTestReportResult => ({ canceled: false, error: null, report });
const loadComparisonReport = async (): Promise<ImportTestReportResult> => {
  if (mode === "pending") return new Promise(resolve => { finishPending = resolve; });
  if (mode === "throw") throw Error("fixture rejection");
  if (mode === "canceled") return { canceled: true, error: null, report: null };
  if (mode === "failed") return { canceled: false, error: "第二份源附件无法读取，原对比保留。", report: null };
  return result(cases[mode]);
};
function PanelHarness({ primary }: { primary: LoadedTestReport }) {
  const [open, updateOpen] = useState(true); setOpen = updateOpen;
  const load = useCallback(async (): Promise<DebugReportExportImportResult> => ({ ...result(primary), exportSourceId: sourceId }), [primary]);
  return <TestReportPanel open={open} onClose={() => updateOpen(false)} loadDebugReport={load} debugReportRequest={1} />;
}
function installApi() {
  Object.assign(window, { electronApi: { importComparisonReport: loadComparisonReport,
    importTestReport: async () => ({ ...result(nextPrimary), exportSourceId: sourceId }),
    exportDebugReportEvidence: async (request: DebugReportExportRequest) => { exportRequests.push(request); return new Promise<DebugReportExportResult>(resolve => { finishExport = resolve; }); },
    cancelDebugReportExport: async () => {},
  } });
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const check = (condition: unknown, message: string) => { if (!condition) throw Error(message); };
async function waitFor(predicate: () => unknown, message: string) { for (let i = 0; i < 200; i++) { if (predicate()) return; await tick(); } throw Error(message); }
const query = <T extends Element>(selector: string) => { const node = host.querySelector<T>(selector); if (!node) throw Error(`Missing ${selector}`); return node; };
const click = (selector: string) => flushSync(() => query<HTMLButtonElement>(selector).click());
const comparison = () => host.querySelector<HTMLElement>("[data-comparison-result]")?.dataset.comparisonResult;
const feedback = () => host.querySelector<HTMLElement>("[data-comparison-feedback]")?.dataset.comparisonState;
async function mount(primary = cases.primary) {
  installApi(); nextPrimary = primary;
  flushSync(() => root.render(<PanelHarness key={++key} primary={primary} />));
  await waitFor(() => host.querySelector(".debug-task-run-comparison"), "Report did not load");
  query<HTMLDetailsElement>(".debug-task-run-comparison").open = true; await tick();
}
async function load(expected: string) {
  click('[data-comparison-action="import"]');
  await waitFor(() => (expected === "loading" || expected === "failed" || expected === "canceled" ? feedback() : comparison()) === expected, `Missing ${expected}`);
  await tick();
}
function finish(report: LoadedTestReport) { check(finishPending, "No pending comparison"); finishPending!(result(report)); finishPending = null; }
async function showTaskComparisonCase(name: "same" | "mismatch" | "missing" | "unchecked") {
  await mount(); mode = name; await load(name === "mismatch" ? "different_definition" : "same_task");
}

async function verifyTaskComparisonUI(input: Cases) {
  cases = input; await mount(); const checks: string[] = [];
  mode = "same"; await load("same_task");
  const final = query<HTMLElement>('[data-comparison-phase-kind="final"]');
  check(final.querySelector('[data-comparison-side="primary"] [data-comparison-status="passed"]'), "Primary reviewed result lost");
  check(final.querySelector('[data-comparison-side="secondary"] [data-comparison-status="failed"]'), "Recorded passed bypassed loader failure");
  check(host.textContent?.includes("second-device") && host.textContent.includes("当前报告") && host.textContent.includes("第二份报告"), "Sources missing");
  query<HTMLDetailsElement>(".debug-run-definition").open = true;
  check(query(".debug-run-definition").textContent?.includes("error-absent") && query(".debug-run-definition").textContent?.includes("资源ID="), "Complete condition definitions hidden");
  query<HTMLDetailsElement>('[data-comparison-phase-kind="final"] [data-comparison-side="secondary"] .debug-run-condition-results').open = true;
  check(final.querySelectorAll('[data-comparison-condition-status="failed"]').length === 2, "Failed conditions missing");
  checks.push("same definition across UUID/device", "loader-reviewed failures", "both report sources", "complete definitions and failed conditions");
  mode = "canceled"; await load("canceled"); check(comparison() === "same_task", "Cancel discarded previous comparison");
  mode = "failed"; await load("failed"); check(comparison() === "same_task" && host.querySelector('[data-comparison-feedback][role="alert"]'), "Error discarded prior comparison");
  mode = "throw"; await load("failed"); check(comparison() === "same_task", "Rejection discarded previous comparison"); checks.push("cancel/error/rejection preserve old comparison");
  mode = "mismatch"; await load("different_definition");
  check(!host.querySelector(".debug-run-results") && host.querySelectorAll(".debug-run-independent").length === 2, "Mismatched definitions were aligned");
  check(host.textContent?.includes("选择器或状态不同"), "Definition mismatch explanation missing"); checks.push("same goal changed definition refuses alignment");
  mode = "missing"; await load("same_task");
  check(query('[data-comparison-phase-kind="final"] [data-comparison-side="secondary"] [data-comparison-status="insufficient_evidence"]'), "Missing tree was promoted to passed");
  mode = "unchecked"; await load("same_task");
  check(query('[data-comparison-phase-kind="final"] [data-comparison-side="secondary"] [data-comparison-status="unchecked"]'), "Unperformed final treated as failure/pass");
  check(host.textContent?.includes("耗时未知"), "Unknown duration fabricated"); checks.push("missing-tree insufficient evidence", "unperformed stages and final", "bounded time ranges");
  await mount(cases.stageFinal); mode = "stageFinal"; await load("same_task");
  check(host.querySelectorAll('[data-comparison-phase="final"][data-comparison-phase-kind="checkpoint"]').length === 1
    && host.querySelectorAll('[data-comparison-phase="final"][data-comparison-phase-kind="final"]').length === 1, "Checkpoint ID final aliased actual final");
  checks.push("checkpoint final is distinct");
  await mount(); mode = "same"; await load("same_task");
  mode = "pending"; await load("loading");
  check([...host.querySelectorAll<HTMLButtonElement>(".test-report-header button")].slice(0, 2).every(button => button.disabled), "Primary loading overlaps comparison");
  query<HTMLDetailsElement>(".debug-report-export").open = true;
  check(query<HTMLButtonElement>('[data-export-action="start"]').disabled && !query<HTMLButtonElement>('[aria-label="关闭测试报告"]').disabled, "Busy interlock or close invalid");
  click('[aria-label="关闭测试报告"]'); await waitFor(() => !query<HTMLDialogElement>("dialog").open, "Report did not close");
  flushSync(() => setOpen(true)); finish(cases.mismatch); await tick(); await tick();
  check(comparison() === "same_task" && !feedback(), "Late load updated reopened panel"); checks.push("busy mutual exclusion", "close/reopen late response isolation");
  mode = "pending"; await load("loading"); click('[data-comparison-action="clear"]'); finish(cases.mismatch); await tick(); await tick();
  check(!comparison() && !feedback(), "Clear restored late comparison"); checks.push("clear discards pending response");
  mode = "pending"; await load("loading"); click('[data-comparison-action="close"]'); finish(cases.mismatch); await tick(); await tick();
  check(!query<HTMLDetailsElement>(".debug-task-run-comparison").open && !comparison(), "Close restored late result"); checks.push("close comparison ignores late response");
  query<HTMLDetailsElement>(".debug-task-run-comparison").open = true; await tick(); mode = "same"; await load("same_task");
  query<HTMLDetailsElement>(".debug-report-export").open = true; click('[data-export-action="start"]');
  await waitFor(() => finishExport, "Export did not start");
  check(query<HTMLButtonElement>('[data-comparison-action="import"]').disabled, "Comparison overlaps export");
  check(exportRequests.at(-1)!.sourceId === "primary-export-source" && exportRequests.at(-1)!.reportSha256 === cases.primary.index.reportSha256, "Comparison replaced primary export source");
  finishExport!({ canceled: true, directory: null, error: null, warnings: [], stepCount: 0 }); finishExport = null; await tick(); await tick();
  nextPrimary = cases.missing; sourceId = "new-primary-source"; click(".test-report-header button");
  await waitFor(() => !comparison(), "Primary replacement did not clear comparison"); checks.push("primary export source preserved", "primary change clears comparison");
  mode = "pending"; await load("loading"); await mount(); finish(cases.mismatch); await tick(); await tick();
  check(!comparison(), "Unmounted response affected new report"); checks.push("unmount late response isolation");
  // Direct prop replacement also invalidates a pending load without remounting the component.
  const draw = (primary: LoadedTestReport) => flushSync(() => root.render(<DebugTaskRunComparison primary={primary} active loadComparisonReport={loadComparisonReport} />));
  draw(cases.primary); query<HTMLDetailsElement>(".debug-task-run-comparison").open = true; await tick(); mode = "pending"; await load("loading");
  draw(cases.missing); finish(cases.mismatch); await tick(); await tick(); check(!comparison() && !feedback(), "Changed primary prop accepted old load");
  checks.push("primary prop late response isolation");
  await mount(cases.noTask);
  check(query<HTMLButtonElement>('[data-comparison-action="import"]').disabled && host.textContent?.includes("没有固定任务定义"), "Legacy no-task report enabled comparison");
  checks.push("legacy no-task boundary");
  sourceId = "primary-export-source"; await showTaskComparisonCase("same");
  return { checks, scope: "Production React report panel with loader-verified offline reports and fixture IPC; no phone access or native file chooser." };
}
Object.assign(window, { verifyTaskComparisonUI, showTaskComparisonCase });
