import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { failedReportAttempt, firstReportStep, type LoadedTestReport, type TestReportAttempt } from "../shared/test-report";
import { diagnoseReportAttempt } from "../src/features/reports/report-diagnosis";
import { TestReportDiagnosis } from "../src/features/reports/TestReportDiagnosis";

const imageUrl = "data:image/png;base64,fixture";
function fixture() {
  const attempt: TestReportAttempt = { id: "attempt", index: 0, status: "passed", durationMs: 10, cleanup: "complete", error: null,
    secondaryErrors: [], failure: null, steps: [{ id: "before", api: "app.screenshot", label: "进入前", status: "passed", durationMs: 1, source: null, error: null }],
    artifacts: [{ id: "image", kind: "screenshot", stepId: "before", failureEvidence: false, availability: "verified", href: null, sha256: null }],
  };
  const images: LoadedTestReport["images"] = [{ attemptId: "attempt", artifactId: "image", dataUrl: imageUrl, error: null }];
  return { attempt, images };
}

test("passed diagnosis describes one historical attempt, not live UI or stable performance", () => {
  const { attempt, images } = fixture();
  const diagnosis = diagnoseReportAttempt(attempt, images);
  assert.equal(diagnosis.state, "passed");
  assert.equal(diagnosis.firstIssue, null);
  assert.equal(diagnosis.loadedScreenshotCount, 1);
  assert.equal(diagnosis.evidence?.stepId, "before");
  assert.ok(diagnosis.advice.some(message => message.includes("不代表长期稳定")));
  const html = renderToStaticMarkup(createElement(TestReportDiagnosis, { attempt, images, onSelectStep: () => { throw new Error("render must not act"); } }));
  assert.match(html, /本次尝试诊断摘要/);
  assert.match(html, /不自动采集、点击、重试或上传/);
  assert.match(html, /查看本次最后关联截图/);
});

test("assertion timeout preserves nearest earlier image, never substitutes a later screenshot", () => {
  const { attempt, images } = fixture();
  attempt.status = "failed";
  attempt.steps.push({ ...attempt.steps[0], id: "input", api: "locator.tap" },
    { ...attempt.steps[0], id: "assert", api: "expect.toHaveText", status: "timedout", error: { code: "ASSERTION_FAILED" } },
    { ...attempt.steps[0], id: "after", api: "app.screenshot" });
  attempt.artifacts.push({ ...attempt.artifacts[0], id: "later-image", stepId: "after", failureEvidence: true });
  images.push({ ...images[0], artifactId: "later-image" });
  const before = JSON.stringify({ attempt, images });
  const diagnosis = diagnoseReportAttempt(attempt, images);
  assert.equal(diagnosis.state, "issue");
  assert.equal(diagnosis.firstIssue?.stepId, "assert");
  assert.equal(diagnosis.firstIssue?.position, 3);
  assert.equal(diagnosis.evidence?.stepId, "before");
  assert.equal(diagnosis.loadedScreenshotCount, 2);
  assert.ok(diagnosis.advice.some(message => message.includes("不等于点击未生效")));
  assert.equal(JSON.stringify({ attempt, images }), before);
});

test("same-step evidence outranks earlier evidence and other attempts cannot alias images", () => {
  const { attempt, images } = fixture();
  attempt.steps.push({ ...attempt.steps[0], id: "failure", api: "expect.toBeVisible", status: "failed" });
  attempt.artifacts.push({ ...attempt.artifacts[0], id: "failure-image", stepId: "failure", failureEvidence: true });
  images.push({ ...images[0], attemptId: "other", artifactId: "failure-image" });
  assert.equal(diagnoseReportAttempt(attempt, images).evidence?.stepId, "before");
  images.push({ ...images[0], artifactId: "failure-image" });
  const diagnosis = diagnoseReportAttempt(attempt, images);
  assert.equal(diagnosis.evidence?.stepId, "failure");
  assert.equal(diagnosis.evidence?.label, "查看异常步骤关联截图");
  assert.equal(diagnosis.loadedScreenshotCount, 2);
});

test("missing, rejected and unlinked screenshots cannot supply a misleading evidence jump", () => {
  const { attempt, images } = fixture();
  for (const image of [undefined, { ...images[0], dataUrl: null, error: "截图已变化" }, { ...images[0], dataUrl: "" }, { ...images[0], error: "错摘要" }]) {
    const diagnosis = diagnoseReportAttempt(attempt, image ? [image] : []);
    assert.equal(diagnosis.loadedScreenshotCount, 0);
    assert.equal(diagnosis.evidence, null);
    assert.ok(diagnosis.advice.some(message => message.includes("1 张截图未加载")));
  }
  attempt.artifacts[0].stepId = "not-a-step";
  assert.equal(diagnoseReportAttempt(attempt, images).evidence, null);
  attempt.artifacts[0].stepId = null;
  assert.equal(diagnoseReportAttempt(attempt, images).evidence, null);
});

test("caught screenshot failure stays visible even when the attempt is marked passed", () => {
  const { attempt, images } = fixture();
  attempt.steps[0].status = "failed";
  const diagnosis = diagnoseReportAttempt(attempt, images);
  assert.equal(diagnosis.state, "issue");
  assert.ok(diagnosis.advice.some(message => message.includes("截图失败不等于页面未跳转")));
  assert.equal(failedReportAttempt(attempt), true);
});

test("blocked steps and cleanup-only failures select/report issues without inventing a failing step", () => {
  const { attempt, images } = fixture();
  attempt.steps.push({ ...attempt.steps[0], id: "blocked", status: "blocked" });
  assert.equal(firstReportStep(attempt), "blocked");
  assert.equal(diagnoseReportAttempt(attempt, images).state, "issue");
  attempt.steps.pop();
  for (const cleanup of ["failed", "forced"] as const) {
    attempt.cleanup = cleanup;
    const diagnosis = diagnoseReportAttempt(attempt, images);
    assert.equal(diagnosis.state, "issue");
    assert.equal(diagnosis.firstIssue, null);
    assert.ok(diagnosis.advice.some(message => message.includes("不自动重试或返回")));
    assert.equal(failedReportAttempt(attempt), true);
  }
});

test("preparation and secondary errors do not invent an input failure", () => {
  const { attempt, images } = fixture();
  attempt.steps = []; attempt.artifacts = []; attempt.error = { phase: "setup", message: "准备失败" };
  let diagnosis = diagnoseReportAttempt(attempt, images);
  assert.equal(diagnosis.firstIssue, null);
  assert.equal(diagnosis.evidence, null);
  assert.equal(diagnosis.state, "issue");
  assert.ok(diagnosis.advice.some(message => message.includes("不足以确定根因")));
  attempt.error = null; attempt.secondaryErrors = [{ phase: "cleanup", message: "留证失败" }];
  diagnosis = diagnoseReportAttempt(attempt, images);
  assert.equal(diagnosis.state, "issue");
  assert.equal(diagnosis.firstIssue, null);
});

test("pending, running, skipped, unknown cleanup and missing steps are not presented as passed", () => {
  const { attempt, images } = fixture();
  for (const status of ["pending", "running", "skipped"] as const) {
    attempt.status = status;
    assert.equal(diagnoseReportAttempt(attempt, images).state, "incomplete");
  }
  attempt.status = "passed"; attempt.cleanup = "unknown";
  assert.equal(diagnoseReportAttempt(attempt, images).state, "incomplete");
  attempt.cleanup = "complete"; attempt.steps = [];
  assert.equal(diagnoseReportAttempt(attempt, images).state, "incomplete");
  attempt.steps = [{ ...fixture().attempt.steps[0], status: "pending" }];
  assert.equal(diagnoseReportAttempt(attempt, images).state, "incomplete");
});

test("error-bearing passed step is an issue; earlier attempts and unavailable media do not disappear", () => {
  const { attempt, images } = fixture();
  attempt.steps[0].error = { message: "步骤附带错误" };
  const issue = diagnoseReportAttempt(attempt, images);
  assert.equal(issue.state, "issue");
  assert.match(issue.firstIssue!.status, /附有错误/);
  const later = fixture(); later.attempt.id = "later"; later.attempt.index = 1; later.attempt.artifacts = [];
  later.attempt.artifacts.push({ ...attempt.artifacts[0], id: "trace", kind: "trace" });
  const success = diagnoseReportAttempt(later.attempt, images);
  assert.equal(success.state, "passed");
  assert.equal(success.screenshotCount, 0);
  assert.equal(success.loadedScreenshotCount, 0);
  assert.ok(success.advice.some(message => message.includes("不能作为视觉通过证据")));
  assert.equal(diagnoseReportAttempt(attempt, images).state, "issue");
});

test("diagnosis and its UI only derive local records, never expose device or network actions", () => {
  const model = readFileSync("src/features/reports/report-diagnosis.ts", "utf8");
  const component = readFileSync("src/features/reports/TestReportDiagnosis.tsx", "utf8");
  assert.doesNotMatch(model + component, /electronApi|inspectDevice|fetch\(|ipcRenderer|startDebugSession|agent\.act|dangerouslySetInnerHTML/);
  const panel = readFileSync("src/features/reports/TestReportPanel.tsx", "utf8");
  assert.match(panel, /<TestReportDiagnosis attempt=\{attempt\} images=\{report\.images\}/);
  assert.match(panel, /onSelectStep=\{stepId => setSelection/);
});
