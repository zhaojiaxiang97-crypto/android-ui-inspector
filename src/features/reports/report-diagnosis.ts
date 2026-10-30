import { failedReportAttempt, failedReportStep, testReportStatusLabel, type LoadedTestReport, type TestReportAttempt } from "../../../shared/test-report";

// Only summarize verified local records. No device lookup, live identity matching or cause inference.
export function diagnoseReportAttempt(attempt: TestReportAttempt, images: LoadedTestReport["images"]) {
  const issueIndex = attempt.steps.findIndex(failedReportStep);
  const firstIssue = issueIndex < 0 ? null : attempt.steps[issueIndex];
  const hasIssue = failedReportAttempt(attempt);
  const completed = attempt.status === "passed" && attempt.cleanup === "complete" && attempt.steps.length > 0
    && attempt.steps.every(step => step.status === "passed" || step.status === "skipped");
  const state = hasIssue ? "issue" : completed ? "passed" : "incomplete";
  const headline = state === "issue" ? "本次尝试存在异常记录" : state === "passed" ? "报告标记本次尝试通过" : "本次尝试尚无完整通过证据";
  const screenshots = attempt.artifacts.filter(artifact => artifact.kind === "screenshot");
  const loaded = screenshots.filter(artifact => images.some(image => image.attemptId === attempt.id
    && image.artifactId === artifact.id && Boolean(image.dataUrl) && image.error === null));
  // An image from another attempt or a later step cannot stand in for the page before this issue.
  const boundary = issueIndex < 0 ? attempt.steps.length - 1 : issueIndex;
  let evidence: { stepId: string; position: number; label: string } | null = null;
  for (let position = 0; position <= boundary; position++) {
    const step = attempt.steps[position];
    if (loaded.some(image => image.stepId === step.id)) evidence = {
      stepId: step.id, position: position + 1,
      label: position === issueIndex ? "查看异常步骤关联截图" : issueIndex >= 0 ? "查看异常前最近截图" : "查看本次最后关联截图",
    };
  }
  const advice: string[] = [];
  if (firstIssue?.api.startsWith("expect.")) advice.push("断言未满足不等于点击未生效；先对照断言、源码位置和已有画面，根因仍需核实。");
  else if (firstIssue?.api === "app.screenshot") advice.push("截图失败不等于页面未跳转；先查看截图步骤和附件错误。");
  else if (hasIssue) advice.push("先查看步骤和尝试级错误；这些记录本身不足以确定根因。");
  if (attempt.cleanup !== "complete") advice.push("收尾未确认完成；先核对清理记录，不自动重试或返回。");
  if (!screenshots.length) advice.push("本次没有截图，文字和断言记录不能作为视觉通过证据。");
  else if (loaded.length < screenshots.length) advice.push(`${screenshots.length - loaded.length} 张截图未加载或核验未通过，不用其他画面代替。`);
  if (state === "passed") advice.push("这仅是一轮报告结果，不代表长期稳定，也不表示手机当前仍在该页面。");
  else if (state === "incomplete") advice.push("执行或收尾记录不完整，不将其标记为通过。");
  return { state, headline, firstIssue: firstIssue ? {
    stepId: firstIssue.id, position: issueIndex + 1, api: firstIssue.api,
    status: firstIssue.error ? `${testReportStatusLabel(firstIssue.status)}（附有错误）` : testReportStatusLabel(firstIssue.status),
  } : null, screenshotCount: screenshots.length, loadedScreenshotCount: loaded.length, evidence, advice };
}
