import { useCallback, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { TestReportPanel } from "../src/features/reports/TestReportPanel";
import type { DebugReportExportApi, DebugReportExportImportResult, DebugReportExportRequest, DebugReportExportResult } from "../shared/debug-report-export";
import "../src/styles/tokens.css";
import "../src/App.css";
import "../src/styles/workbench.css";

const host = document.createElement("main"); document.body.append(host);
const root = createRoot(host);
let mode: "complete" | "failed" | "canceled" | "pending" = "complete";
let finishPending: ((result: DebugReportExportResult) => void) | null = null;
let setOpen: (value: boolean) => void = () => {};
let mountedReport: DebugReportExportImportResult, folder = "", generation = 0;
const requests: DebugReportExportRequest[] = [], canceledIds: string[] = [];
const complete = (directory = folder): DebugReportExportResult => ({ canceled: false, directory, error: null, stepCount: 3,
  warnings: ["原报告没有保存此步骤日志。"] });
const canceled: DebugReportExportResult = { canceled: true, directory: null, error: null, stepCount: 0, warnings: [] };
const api: DebugReportExportApi = {
  exportDebugReportEvidence: async request => {
    requests.push(structuredClone(request));
    if (mode === "pending") return new Promise(resolve => { finishPending = resolve; });
    return mode === "complete" ? complete() : mode === "canceled" ? canceled
      : { canceled: false, directory: null, error: "源证据已改变，请重新读取报告。", stepCount: 0, warnings: [] };
  },
  cancelDebugReportExport: async requestId => { canceledIds.push(requestId); },
};
function Harness({ result }: { result: DebugReportExportImportResult }) {
  const [open, updateOpen] = useState(true); setOpen = updateOpen;
  const load = useCallback(async () => result, [result]);
  return <TestReportPanel open={open} onClose={() => updateOpen(false)} loadDebugReport={load} debugReportRequest={1} />;
}
const check = (condition: unknown, message: string) => { if (!condition) throw Error(message); };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function waitFor(condition: () => unknown, message: string) {
  for (let attempt = 0; attempt < 200; attempt++) { if (condition()) return; await tick(); }
  throw Error(message);
}
const query = <T extends Element>(selector: string) => {
  const value = host.querySelector<T>(selector); if (!value) throw Error(`Missing ${selector}`); return value;
};
const click = (selector: string) => flushSync(() => query<HTMLButtonElement>(selector).click());
const feedback = () => host.querySelector<HTMLElement>("[data-export-feedback]")?.dataset.exportState;
async function mount(result: DebugReportExportImportResult, supported = true) {
  Object.assign(window, { electronApi: { ...(supported ? api : {}), importTestReport: async () => result } });
  flushSync(() => root.render(<Harness key={++generation} result={result} />));
  await waitFor(() => host.querySelector(".debug-report-export"), "Report did not load");
  query<HTMLDetailsElement>(".debug-report-export").open = true;
  await tick();
}
function scope(value: "current" | "all") {
  flushSync(() => { const select = query<HTMLSelectElement>("[data-export-scope]"); select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function start(expected: string) { click('[data-export-action="start"]'); await waitFor(() => feedback() === expected, `Missing ${expected} feedback`); }
function finish(result: DebugReportExportResult) { check(finishPending, "No pending export"); finishPending!(result); finishPending = null; }

async function verifyDebugReportExportUI(result: DebugReportExportImportResult, directory: string) {
  mountedReport = result; folder = directory;
  await mount(result);
  const checks: string[] = [];
  check(query<HTMLSelectElement>("[data-export-scope]").value === "current", "Current step is not default");
  check(query<HTMLSelectElement>("[data-export-scope]").textContent?.includes("当前步骤 #2"), "Failure step selection lost");
  check([...host.querySelectorAll<HTMLInputElement>("[data-export-include]")].every(input => input.checked), "Default attachments not included");
  scope("all"); click('[data-export-include="trees"]'); click('[data-export-include="screenshots"]'); click('[data-export-include="logs"]');
  await start("complete");
  const all = requests.at(-1)!;
  check(all.stepIds === "all" && !all.includeTrees && !all.includeScreenshots && !all.includeLogs, "Export switches were not passed through");
  check(all.sourceId === result.exportSourceId && all.reportSha256 === result.report!.index.reportSha256 && !Object.prototype.hasOwnProperty.call(all, "filePath"), "Uncontrolled source request");
  check(host.textContent?.includes(directory) && host.textContent.includes("移动整个文件夹"), "Completion cannot be understood");
  checks.push("current/all selection", "three include switches", "opaque source and hash", "completion and omissions");
  mode = "failed"; scope("current"); await start("failed");
  check(JSON.stringify(requests.at(-1)!.stepIds) === "[2]", "Current step did not map to selected ID");
  check(host.querySelector('[data-export-feedback][role="alert"]')?.textContent?.includes("源证据已改变"), "Failure is not announced");
  mode = "canceled"; await start("canceled"); checks.push("failed retry", "native folder cancellation");
  mode = "pending"; await start("busy");
  check(query<HTMLSelectElement>("[data-export-scope]").disabled && query<HTMLButtonElement>('[data-export-action="start"]').disabled, "Pending options can change");
  check([...host.querySelectorAll<HTMLButtonElement>(".test-report-header button")].slice(0, 2).every(button => button.disabled), "Report source can change while exporting");
  const requestId = requests.at(-1)!.requestId;
  click('[data-export-action="cancel"]'); check(feedback() === "canceling", "Cancel state missing");
  check(canceledIds.includes(requestId), "Cancel did not target the pending request");
  finish(canceled); await waitFor(() => feedback() === "canceled", "Canceled export did not settle");
  check(!query<HTMLButtonElement>('[data-export-action="start"]').disabled, "Cancel did not release controls");
  checks.push("busy controls", "request cancellation and settle");
  await start("busy"); const closingId = requests.at(-1)!.requestId;
  click('[aria-label="关闭测试报告"]'); await waitFor(() => !query<HTMLDialogElement>("dialog").open, "Close did not hide report");
  check(canceledIds.includes(closingId), "Close did not cancel export");
  flushSync(() => setOpen(true)); finish(complete("LATE_RESPONSE_SHOULD_NOT_APPEAR")); await tick(); await tick();
  check(!feedback() && !host.textContent?.includes("LATE_RESPONSE_SHOULD_NOT_APPEAR"), "Closed export updated reopened report");
  checks.push("close cancels", "late response isolation");
  await mount({ ...result, exportSourceId: undefined });
  check(query<HTMLButtonElement>('[data-export-action="start"]').disabled && host.textContent?.includes("来源尚未登记"), "Old reports enabled unsafe export");
  await mount(result, false);
  check(query<HTMLButtonElement>('[data-export-action="start"]').disabled && host.textContent?.includes("当前版本不支持证据导出"), "Missing API enabled export");
  checks.push("unregistered legacy source", "missing API");
  await mount(mountedReport); mode = "complete"; scope("all"); await start("complete");
  return { checks, requests: requests.length, canceledRequests: canceledIds.length, scope: "Production React report UI; fixture API; no phone access or native chooser." };
}
Object.assign(window, { verifyDebugReportExportUI });
