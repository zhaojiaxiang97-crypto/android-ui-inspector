import type { DebugTaskCheckResult, DebugTaskCondition } from "../../../shared/debug-task";
import { debugTaskConditionLabel, debugTaskStatusLabel, debugTaskView, type DebugReportData } from "./debug-report-view";

function Conditions({ conditions }: { conditions: DebugTaskCondition[] }) {
  return <ul className="debug-task-fixed-conditions">{conditions.map(condition => <li key={condition.id}><strong>{condition.id}</strong>：{debugTaskConditionLabel(condition)}</li>)}</ul>;
}

export function DebugTaskSummary({ data, onSelectCheck }: { data: DebugReportData; onSelectCheck: (check: DebugTaskCheckResult) => void }) {
  const view = debugTaskView(data);
  if (!view) return null;
  const { task, finalCheck, finalAssessment } = view;
  const status = finalAssessment?.status ?? "insufficient_evidence";
  return <section className="debug-task-summary" aria-label="任务验收摘要" data-task-status={status} data-task-review-needed={view.needsReview}>
    <h4>任务验收 · <strong data-task-status={status}>{finalCheck ? `历史结果：${debugTaskStatusLabel(status)}` : "尚未最终验收"}</strong></h4>
    <p className="debug-task-goal">原始目标：{task.definition.goal}</p>
    <p>目标固定于步骤 #{task.definedStepId} · {task.definedAt}</p>
    <p>自然语言仅说明目标；验收按下列固定条件。结果对应检查时的观察，不证明手机当前状态。</p>
    {finalAssessment && <p className="debug-task-reason">{finalAssessment.reason}</p>}
    {view.needsReview && <p className="debug-report-warning" role="status">需重新验收：{view.laterInput
      ? `最终验收后步骤 #${view.laterInput.step.id} 又进行了输入或派发未确认。` : "最终验收后的部分步骤已丢弃，无法确认后续操作。"} 当时的验收结果仍保留。</p>}
    <details className="debug-task-checkpoints">
      <summary>阶段与最终验收 · {view.checkpoints.filter(item => item.assessment?.status === "passed").length}/{view.checkpoints.length} 个阶段有效通过</summary>
      <ol>{view.checkpoints.map(({ checkpoint, check, assessment }) => <li key={checkpoint.id} data-task-checkpoint={checkpoint.id} data-task-status={assessment?.status ?? "insufficient_evidence"}>
        <div><strong>{checkpoint.title}</strong><span>{assessment ? `当时${debugTaskStatusLabel(assessment.status)}` : "尚未验收"}</span></div>
        {check && <><p>步骤 #{check.stepId} · {check.checkedAt} · {assessment?.reason}</p><button type="button" className="close-button" data-task-check-step={check.stepId} onClick={() => onSelectCheck(check)}>查看验收 #{check.stepId} 的记录与观察</button></>}
        <details><summary>固定条件 · {checkpoint.id}</summary><Conditions conditions={checkpoint.conditions} /></details>
      </li>)}</ol>
      <div className="debug-task-final" data-task-checkpoint="final" data-task-status={status}>
        <strong>最终验收：{finalCheck ? `当时${debugTaskStatusLabel(status)}` : "尚未进行"}</strong>
        {finalCheck && <><p>步骤 #{finalCheck.stepId} · {finalCheck.checkedAt}</p><button type="button" className="close-button" data-task-check-step={finalCheck.stepId} onClick={() => onSelectCheck(finalCheck)}>查看最终验收 #{finalCheck.stepId} 的记录与观察</button></>}
        <details><summary>固定最终条件</summary><Conditions conditions={task.definition.finalConditions} /></details>
      </div>
    </details>
  </section>;
}
