import type { LoadedTestReport, TestReportAttempt } from "../../../shared/test-report";
import { diagnoseReportAttempt } from "./report-diagnosis";

type Props = { attempt: TestReportAttempt; images: LoadedTestReport["images"]; onSelectStep: (stepId: string) => void };

export function TestReportDiagnosis({ attempt, images, onSelectStep }: Props) {
  const diagnosis = diagnoseReportAttempt(attempt, images);
  return <section className="test-report-diagnosis" aria-label="本次尝试诊断摘要">
    <h4>{diagnosis.headline}</h4>
    {diagnosis.firstIssue && <p>首次异常：第 {diagnosis.firstIssue.position} 步 · {diagnosis.firstIssue.api} · {diagnosis.firstIssue.status}</p>}
    <p>本地截图：已载入 {diagnosis.loadedScreenshotCount} / {diagnosis.screenshotCount} 张</p>
    {diagnosis.advice.map(message => <p key={message}>{message}</p>)}
    <div className="test-report-diagnosis-actions">
      {diagnosis.firstIssue && <button type="button" className="close-button" onClick={() => onSelectStep(diagnosis.firstIssue!.stepId)}>定位首次异常</button>}
      {diagnosis.evidence && <button type="button" className="close-button" onClick={() => onSelectStep(diagnosis.evidence!.stepId)}>{diagnosis.evidence.label} · 第 {diagnosis.evidence.position} 步</button>}
    </div>
    <small>仅整理已有报告，不自动采集、点击、重试或上传。关联截图不是实时绘制图层身份。</small>
  </section>;
}
