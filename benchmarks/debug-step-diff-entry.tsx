import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { makeDebugDiffReportFixture, type DiffFixtureState } from "./debug-step-diff-fixtures";
import { DebugReportStepDiff } from "../src/features/reports/DebugReportStepDiff";
import { DebugReportStepDetails } from "../src/features/reports/DebugReportStepDetails";
import { debugStepSnapshotDiff } from "../src/features/reports/debug-report-view";
import "../src/styles/tokens.css";
import "../src/features/reports/test-report.css";

const root = createRoot(document.getElementById("root")!);
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const expected = { normal: "compared", empty: "compared", partial: "partial", missing: "unavailable", error: "unavailable", check: "compared" };

async function verify(state: DiffFixtureState, fullStep = false, longText = false) {
  const f = makeDebugDiffReportFixture(state);
  if (longText) f.data.snapshots[1].snapshot!.root!.children[1].text = "这是长度较大的保存文本。".repeat(500);
  const before = JSON.stringify(f), diff = debugStepSnapshotDiff(f.data, f.record);
  flushSync(() => root.render(<main className="test-report-dialog debug-diff-check-surface">
    <header><h2>Artemis · 历史观察</h2><p>步骤 #{f.record.step.id} · {state === "check" ? "Checker 两次留证" : "执行前后留证"}</p></header>
    {fullStep ? <DebugReportStepDetails {...f} /> : <DebugReportStepDiff diff={diff} taskCheck={state === "check"} />}
  </main>));
  await frame();
  const section = document.querySelector<HTMLElement>(".debug-step-diff")!;
  assert(section?.dataset.diffStatus === expected[state], `${state}: wrong comparison status`);
  assert(section.textContent?.includes("不改变 Checker 验收结果"), "Missing independent verdict boundary");
  if (state === "error") assert(section.textContent?.includes("节点文件校验失败"), "Real load error was hidden");
  if (state === "missing") assert(section.textContent?.includes("之前的观察"), "Previous observation was not explained");
  if (state === "empty") assert(section.textContent?.includes("未发现属性变化"), "Missing empty comparison state");
  if (longText) assert(section.textContent?.includes("完整内容见历史节点属性"), "Long text was not bounded");
  assert(JSON.stringify(f) === before, "Historical data mutated");
  assert(section.scrollWidth <= section.clientWidth + 1, `${state}: diff overflows at ${innerWidth}`);
  assert(document.documentElement.scrollWidth <= innerWidth + 1, `${state}: viewport overflows at ${innerWidth}`);
  if (state === "normal" || state === "check" || state === "partial") {
    assert(section.querySelectorAll("[data-diff-kind]").length === 3, "Expected added, removed and property rows");
    assert(section.textContent?.includes("启用") && section.textContent?.includes("位置（屏幕像素）"), "Missing changed properties");
  }
  if (state === "check" && fullStep) assert(document.querySelector(".debug-task-check-detail")?.getAttribute("data-task-status") === "failed", "Checker verdict changed");
  const details = section.querySelector<HTMLDetailsElement>(".debug-step-diff-changes");
  if (details) {
    const summary = details.querySelector("summary")!;
    summary.click(); assert(!details.open, "Change list failed to collapse");
    summary.click(); assert(details.open, "Change list failed to reopen");
    summary.focus(); assert(document.activeElement === summary, "Summary is not keyboard focusable");
  }
  const unmatched = section.querySelector<HTMLDetailsElement>(".debug-step-diff-unmatched");
  if (unmatched) { unmatched.querySelector("summary")!.click(); assert(unmatched.open, "Unconfirmed history failed to expand"); }
  await frame();
  for (const table of section.querySelectorAll("table")) assert(table.scrollWidth <= table.clientWidth + 1, "Property table overflows");
  return { state, viewport: innerWidth, fullStep, longText, status: diff.status, counts: diff.counts,
    fitsViewport: true, fitsDiff: true, verdictUnchanged: true, historicalDataUnchanged: true };
}

declare global { interface Window { verifyDebugStepDiff: typeof verify } }
window.verifyDebugStepDiff = verify;
