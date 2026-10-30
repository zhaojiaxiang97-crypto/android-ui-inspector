import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import { TestReportPanel } from "../src/features/reports/TestReportPanel";
import type { ImportTestReportResult } from "../shared/test-report";

const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(`Report lifecycle: ${message}`); }
function deferred() {
  let resolve!: (value: ImportTestReportResult) => void, reject!: (reason: Error) => void;
  const promise = new Promise<ImportTestReportResult>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function result(id: string): ImportTestReportResult {
  return { canceled: false, error: null, report: { images: [], index: {
    schemaVersion: "inspector-e2e-index-1", generatedAt: "fixture", reportSha256: "0".repeat(64), cases: [],
    run: { id, status: "passed", exitCode: 0, startedAt: "fixture", finishedAt: "fixture", runner: { name: "fixture", version: "1" }, modelTokens: 0, errors: [] },
  } } };
}

// Render the actual component; deferred replies model the native IPC boundary only.
export async function verifyReportImportLifecycle(root: Root) {
  const original = window.electronApi;
  let next = deferred(), calls = 0;
  const bridge = { ...original, importTestReport: () => { calls++; return next.promise; } };
  window.electronApi = bridge;
  const render = (open: boolean) => flushSync(() => root.render(<TestReportPanel open={open} onClose={() => render(false)} />));
  const importButton = () => document.querySelector<HTMLButtonElement>(".test-report-header button")!;
  const alert = () => document.querySelector(".test-report-dialog > [role=alert]");
  const runId = () => document.querySelector(".test-report-summary")?.textContent ?? "";
  async function settle() { await tick(); await tick(); }
  async function start() { flushSync(() => importButton().click()); await settle(); check(importButton().disabled, "import did not enter waiting state"); }
  async function close() { flushSync(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭测试报告"]')!.click()); await settle(); }
  async function reopen() { render(true); await settle(); check(!importButton().disabled, "reopening retained an abandoned waiting state"); }
  try {
    flushSync(() => root.render(null)); render(true); await settle();
    const first = next; await start(); flushSync(() => importButton().click());
    check(calls === 1, "busy import dispatched twice");
    first.resolve(result("kept-report")); await settle(); check(runId().includes("kept-report"), "initial report did not load");

    const lateSuccess = next = deferred(); await start(); await close(); await reopen();
    const current = next = deferred(); await start(); lateSuccess.resolve(result("abandoned-report")); await settle();
    check(importButton().disabled && runId().includes("kept-report") && !alert(), "old success replaced the report or cleared a newer wait");
    current.resolve(result("current-report")); await settle(); check(runId().includes("current-report") && !importButton().disabled, "new reply did not finish");

    const lateError = next = deferred(); await start(); await close(); await reopen();
    const newer = next = deferred(); await start(); lateError.reject(new Error("abandoned failure")); await settle();
    check(!alert() && importButton().disabled && runId().includes("current-report"), "old rejection leaked into the reopened panel");
    newer.resolve({ canceled: true, report: null, error: null }); await settle();
    check(!importButton().disabled && runId().includes("current-report") && !alert(), "cancel lost the prior report");

    next = deferred(); await start(); next.reject(new Error("current failure")); await settle();
    check(alert() && !importButton().disabled && runId().includes("current-report"), "current rejection lost the report or waiting state");
    const lateCancel = next = deferred(); await start();
    flushSync(() => document.querySelector(".test-report-dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })));
    await settle(); check(!document.querySelector<HTMLDialogElement>(".test-report-dialog")!.open, "Escape cancel did not close the panel");
    await reopen(); lateCancel.resolve({ canceled: true, report: null, error: null }); await settle();
    check(!alert() && runId().includes("current-report"), "late cancel changed the retained report");

    const unmounted = next = deferred(); await start(); flushSync(() => root.render(null));
    render(true); await settle(); unmounted.resolve(result("unmounted-report")); await settle();
    check(!runId() && !alert() && !importButton().disabled, "unmounted reply leaked into a new panel");
    return { fixtureOnly: true, scenarios: ["single import while busy", "close/reopen resets wait", "late success cannot replace report or clear newer wait", "late rejection stays isolated", "cancel and current errors keep prior report", "Escape invalidates pending reply", "unmounted reply stays isolated"], calls };
  } finally { flushSync(() => root.render(null)); window.electronApi = original; }
}
