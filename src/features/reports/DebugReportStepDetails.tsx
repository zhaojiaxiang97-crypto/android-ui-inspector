import { useMemo, useState } from "react";
import { DebugReportStepLogs } from "./DebugReportStepLogs";
import { DebugReportStepDiff } from "./DebugReportStepDiff";
import type { DebugReportStep } from "../../../shared/debug-report";
import type { LoadedTestReport, TestReportStep } from "../../../shared/test-report";
import type { DebugTaskCheckResult } from "../../../shared/debug-task";
import type { PixelSize, UiNode } from "../../../shared/types";
import { nodeDisplayLabel } from "../../../shared/tree-utils";
import { debugDispatchLabel, debugInputMarker, debugNodeProperties, debugObservation, debugSnapshotNodes, debugTaskObservation,
  debugTaskCheckAssessment, debugTaskConditionLabel, debugTaskStatusLabel, debugStepDisplayMessage, debugStepOutcomeLabel, debugVerificationState,
  debugStepSnapshotDiff, debugTaskSnapshotDiff, uniqueDebugNode, type DebugInputMarker, type DebugReportData } from "./debug-report-view";

type Props = { data: DebugReportData; images: LoadedTestReport["images"]; record: DebugReportStep; step: TestReportStep };

function InputMarker({ marker, size }: { marker: DebugInputMarker; size: PixelSize }) {
  const action = marker.action;
  const radius = Math.max(2, Math.min(size.width, size.height) * 0.025);
  const color = marker.confirmed ? "#ff4c4c" : "#f4b450";
  const x = action.kind === "tap" ? action.x : action.fromX, y = action.kind === "tap" ? action.y : action.fromY;
  let arrow: string | null = null;
  if (action.kind === "swipe") {
    const distance = Math.hypot(action.toX - x, action.toY - y);
    if (distance > 0) {
      const ux = (action.toX - x) / distance, uy = (action.toY - y) / distance;
      const length = Math.min(radius * 2, distance / 2), width = length / 2;
      arrow = `${action.toX},${action.toY} ${action.toX - ux * length - uy * width},${action.toY - uy * length + ux * width} ${action.toX - ux * length + uy * width},${action.toY - uy * length - ux * width}`;
    }
  }
  return <svg className="debug-report-input-marker" viewBox={`0 0 ${size.width} ${size.height}`} aria-label={marker.label} data-confirmed={marker.confirmed} data-kind={action.kind} role="img">
    {action.kind === "swipe" && <>
      <line x1={x} y1={y} x2={action.toX} y2={action.toY} stroke={color} strokeWidth="3" vectorEffect="non-scaling-stroke" strokeDasharray={marker.confirmed ? undefined : "6 5"} />
      {arrow && <polygon points={arrow} fill={color} />}
    </>}
    <circle cx={x} cy={y} r={radius} fill="none" stroke={color} strokeWidth="3" vectorEffect="non-scaling-stroke" strokeDasharray={marker.confirmed ? undefined : "5 4"} />
    <circle cx={x} cy={y} r={radius / 5} fill={color} />
  </svg>;
}

function NodeProperties({ node, label }: { node: UiNode; label: string }) {
  return <details className="debug-report-properties" open><summary>{label} · #{node.id} · {nodeDisplayLabel(node)}</summary><pre>{JSON.stringify(debugNodeProperties(node), null, 2)}</pre></details>;
}

function SnapshotObservation({ data, images, record, check, side }: { data: DebugReportData; images: LoadedTestReport["images"]; record?: DebugReportStep; check?: DebugTaskCheckResult; side: "before" | "after" }) {
  const taskObservation = check ?? (record?.step.action === "check_debug_task" ? record.step.taskCheck : undefined);
  const observation = taskObservation ? debugTaskObservation(data, images, taskObservation, side) : debugObservation(data, images, side, record!);
  const [size, setSize] = useState<PixelSize | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<UiNode | null>(null);
  const snapshot = observation.saved?.snapshot ?? null;
  const nodes = useMemo(() => debugSnapshotNodes(snapshot, query), [snapshot, query]);
  const isFreshBefore = side === "before" && observation.reference.freshness === "current" && record?.step.action !== "check_debug_task";
  const targetId = isFreshBefore ? record?.step.resolvedInput?.targetNodeId : undefined;
  const anchorId = isFreshBefore ? record?.step.resolvedInput?.anchorNodeId : undefined;
  const target = useMemo(() => uniqueDebugNode(snapshot, targetId), [snapshot, targetId]);
  const anchor = useMemo(() => uniqueDebugNode(snapshot, anchorId), [snapshot, anchorId]);
  const imageUrl = observation.image?.error || imageFailed ? null : observation.image?.dataUrl;
  const position = record ? debugInputMarker(record, side, imageUrl ? size : null) : { marker: null, reason: null };
  const action = position.marker?.action;
  return <section className="debug-report-observation" aria-label={observation.label} data-observation={side} data-freshness={observation.reference.freshness}
    data-task-observation={check || record?.step.action === "check_debug_task" ? side === "before" ? "first" : "second" : undefined}>
    <h4>{observation.label}</h4>
    {observation.saved ? <p>观察时间 {observation.saved.evidence.capturedAt} · 来源 {observation.saved.evidence.source}</p> : <p role="status">没有可读取的对应观察。</p>}
    {observation.reference.reason && <p role="status">{observation.reference.reason}</p>}
    {observation.saved?.evidence.warnings.map((warning, i) => <p key={i} className="debug-report-warning" role="status">留证提示：{warning}</p>)}
    {snapshot?.warning && <p className="debug-report-warning" role="status">观察提示：{snapshot.warning}</p>}
    <div className="test-report-images"><figure>
      {imageUrl ? <div className="debug-report-image-frame">
        <img src={imageUrl} alt={`${observation.label}的本地截图`} onLoad={event => {
          const image = event.currentTarget;
          setSize({ width: image.naturalWidth, height: image.naturalHeight });
        }} onError={() => { setImageFailed(true); setSize(null); }} />
        {position.marker && size && <InputMarker marker={position.marker} size={size} />}
      </div> : <p className="test-report-no-image" role="status">{observation.image?.error ?? (imageFailed ? "截图无法显示。" : "没有保留或加载此观察的截图。")}</p>}
      <figcaption>{observation.label} · 历史记录 · 仅本地查看</figcaption>
      {position.marker && <p className="debug-report-position" data-confirmed={position.marker.confirmed}>
        {position.marker.label} · {action?.kind === "tap" ? `点击 (${action.x}, ${action.y})`
          : action?.kind === "swipe" ? `滑动 (${action.fromX}, ${action.fromY}) → (${action.toX}, ${action.toY}) · ${action.durationMs} ms` : ""}
      </p>}
      {imageUrl && position.reason && <p className="debug-report-warning" role="status">{position.reason}</p>}
    </figure></div>
    {observation.saved?.treeError && <p className="debug-report-warning" role="status">节点留证不可用：{observation.saved.treeError}</p>}
    {snapshot?.error && <p className="debug-report-warning" role="status">观察错误：{snapshot.error}</p>}
    {snapshot?.root ? <>
      {target && <NodeProperties node={target} label="此观察中记录的目标属性" />}
      {targetId && !target && <p className="debug-report-warning">记录的目标 #{targetId} 在此树中缺失或编号不唯一，不能确定目标属性。</p>}
      {anchor && anchorId !== targetId && <NodeProperties node={anchor} label="此观察中记录的定位锚点属性" />}
      <details className="debug-report-node-query"><summary>查找此观察中的节点与属性</summary>
        <p>仅查询保存时的树，不代表手机当前控件。</p>
        <label>查找历史节点<input type="search" aria-label="筛选历史控件" value={query} onChange={event => setQuery(event.target.value)} placeholder="文字、ID、类名或属性" /></label>
        <p>匹配 {nodes.total} 个，最多显示前50个。</p>
        <ul>{nodes.rows.map((node, i) => <li key={`${node.id}:${i}`}><button type="button" onClick={() => setSelected(node)}>
          <strong>{nodeDisplayLabel(node)}</strong><span>#{node.id} · {node.className ?? "类型未记录"}</span>
        </button></li>)}</ul>
        {!nodes.total && <p>没有匹配的历史节点。</p>}
        {selected && <NodeProperties node={selected} label="所选历史节点属性" />}
      </details>
    </> : <p role="status">没有可查询的节点与属性记录。</p>}
  </section>;
}

function TaskCheckDetails({ data, check }: { data: DebugReportData; check: DebugTaskCheckResult }) {
  const assessment = debugTaskCheckAssessment(data, check);
  const checkpoint = data.task?.definition.checkpoints.find(item => item.id === check.checkpointId);
  const conditions = check.checkpointId === null ? data.task?.definition.finalConditions : checkpoint?.conditions;
  return <section className="debug-task-check-detail" aria-label="所选任务验收结果" data-task-status={assessment.status} data-task-check-step={check.stepId}>
    <p><strong>{check.checkpointId === null ? "最终条件验收" : `阶段验收：${checkpoint?.title ?? check.checkpointId}`} · {debugTaskStatusLabel(assessment.status)}</strong></p>
    <p>检查步骤 #{check.stepId} · {check.checkedAt}</p>
    <p>只读验收，按两次新观察检查；前置条件不足时不采集。不派发输入，实际留证见下方，结果对应检查当时。</p>
    <p>{assessment.reason}</p>
    <ul>{assessment.conditions.map(result => { const condition = conditions?.find(item => item.id === result.conditionId); return <li key={result.conditionId} className="debug-task-condition-result" data-condition-id={result.conditionId} data-task-status={result.status}>
      <strong>{result.conditionId} · {debugTaskStatusLabel(result.status)}</strong>
      {condition && <p>{debugTaskConditionLabel(condition)}</p>}
      <p>{result.reason}</p><p>第1次匹配 {result.firstMatchCount} 个 · 第2次匹配 {result.secondMatchCount} 个</p>
      {result.firstNodeId && <p>第1次节点 #{result.firstNodeId}</p>}{result.secondNodeId && <p>第2次节点 #{result.secondNodeId}</p>}
    </li>; })}</ul>
  </section>;
}

export function DebugTaskCheckEvidence({ data, images, check }: { data: DebugReportData; images: LoadedTestReport["images"]; check: DebugTaskCheckResult }) {
  const diff = useMemo(() => debugTaskSnapshotDiff(data, check), [data, check]);
  return <div className="debug-report-step-detail" aria-label="任务验收历史证据">
    <h3>验收 #{check.stepId} · 保存的历史证据</h3>
    <p>此执行步骤已不在最近100步中；按任务保留的验收观察查询。</p>
    <TaskCheckDetails data={data} check={check} />
    <DebugReportStepDiff diff={diff} taskCheck />
    <div className="debug-report-observations">{(["before", "after"] as const).map(side => <SnapshotObservation key={`${check.stepId}:${side}`} data={data} images={images} check={check} side={side} />)}</div>
  </div>;
}

export function DebugReportStepDetails({ data, images, record, step }: Props) {
  const diff = useMemo(() => debugStepSnapshotDiff(data, record), [data, record]);
  const receipt = record.step.inputEvidence;
  const verification = debugVerificationState(record);
  const taskCheck = record.step.action === "check_debug_task";
  return <div className="debug-report-step-detail" aria-label="调试步骤详情">
    <h3>#{record.step.id} · {record.step.action}</h3>
    <p>{debugStepOutcomeLabel(record, data)} · {record.durationMs} ms · {taskCheck ? "只读验收，不派发输入" : `输入派发：${debugDispatchLabel(record.step)}`}</p>
    <p>开始 {record.step.time} · 结束 {record.finishedAt}</p>
    <p>{debugStepDisplayMessage(record, data)}</p>
    {taskCheck ? record.step.taskCheck ? <TaskCheckDetails data={data} check={record.step.taskCheck} /> : <p className="debug-report-verdict" data-task-status="insufficient_evidence">没有可复核的任务验收结果；证据不足。</p>
      : <p className="debug-report-verdict">{verification === "passed" ? data.task ? "此步骤的页面断言通过；不改变独立任务验收结果。" : "此步骤的页面断言通过；整体业务目标仍未验收。"
        : verification === "failed" ? "此步骤的页面断言未通过，需结合对应观察查看。" : "此步骤尚未验收；操作完成或输入已发送不代表业务目标达成。"}</p>}
    {step.error && <div className="test-report-error"><strong>结构化步骤错误</strong><pre>{JSON.stringify(step.error, null, 2)}</pre></div>}
    {record.step.recordingErrors?.length ? <details className="debug-report-recording-errors" open><summary>此步骤的留证缺失或错误</summary><pre>{JSON.stringify(record.step.recordingErrors, null, 2)}</pre></details> : null}
    {!taskCheck && receipt && <details className="debug-report-receipt" open={receipt.classification !== "accepted"}>
      <summary>输入回执 · {receipt.classification}</summary>
      <p>进程已启动：{receipt.spawned ? "是" : "否"} · 退出已确认：{receipt.closed ? "是" : "否"} · 退出码：{receipt.exitCode ?? "未知"} · {receipt.durationMs} ms</p>
      <pre>{JSON.stringify(receipt, null, 2)}</pre>
    </details>}
    <details className="debug-report-request"><summary>请求和解析后的目标</summary><pre>{JSON.stringify({ input: record.step.input, resolvedInput: record.step.resolvedInput ?? null }, null, 2)}</pre></details>
    <DebugReportStepLogs record={record} />
    <DebugReportStepDiff diff={diff} taskCheck={taskCheck} />
    <div className="debug-report-observations">{(["before", "after"] as const).map(side => <SnapshotObservation key={`${record.step.id}:${side}:${record[side].snapshotId}`} data={data} images={images} record={record} side={side} />)}</div>
  </div>;
}
