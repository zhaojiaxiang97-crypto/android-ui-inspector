import type { DebugDiffNode, DebugNodeChange, DebugSnapshotDiff } from "../../../shared/debug-snapshot-diff";
import "./debug-report-step-diff.css";

const fields: Record<DebugNodeChange["fields"][number], string> = {
  text: "文字", contentDesc: "描述", bounds: "位置（屏幕像素）", enabled: "启用", visibleToUser: "可见", clickable: "可点击", selected: "选中",
};
const kindLabel = { added: "新增记录", removed: "消失记录", changed: "属性变化" };
const statusLabel = { compared: "已比较", partial: "部分可比", unavailable: "无法比较" };
const short = (text: string) => text.length <= 1_000 ? text : `${text.slice(0, 1_000)}…（文字较长，完整内容见历史节点属性）`;
const nodeLabel = (node: DebugDiffNode) => short(node.resourceId ?? node.text ?? node.contentDesc ?? node.className ?? "无稳定标识的节点");
const value = (node: DebugDiffNode | null, field: DebugNodeChange["fields"][number]) => {
  if (!node) return "本次树中无此资源控件";
  if (field === "bounds") return node.bounds
    ? `[${node.bounds.left}, ${node.bounds.top}] → [${node.bounds.right}, ${node.bounds.bottom}]` : "位置未记录";
  if (field === "text" || field === "contentDesc") return short(node[field] || (field === "text" ? "无文字" : "无描述"));
  return node[field] ? "是" : "否";
};

function ChangeRow({ change, taskCheck }: { change: DebugNodeChange; taskCheck: boolean }) {
  const node = change.after ?? change.before!;
  const shownFields = change.kind === "changed" ? change.fields : (["text"] as const);
  return <li className="debug-step-diff-row" data-diff-kind={change.kind}>
    <div className="debug-step-diff-node"><span>{kindLabel[change.kind]}</span><strong>{nodeLabel(node)}</strong><small>{node.className}</small></div>
    <table><caption className="debug-step-diff-caption">{nodeLabel(node)}的记录变化</caption><thead><tr><th scope="col">属性</th>
      <th scope="col">{taskCheck ? "第1次观察" : "操作前"}</th><th scope="col">{taskCheck ? "第2次观察" : "操作后"}</th></tr></thead>
      <tbody>{shownFields.map(field => <tr key={field}><th scope="row">{fields[field]}</th>
        <td data-side="before">{value(change.before, field)}</td><td data-side="after">{value(change.after, field)}</td></tr>)}</tbody>
    </table>
  </li>;
}

function UnmatchedNodes({ nodes, total, label }: { nodes: DebugDiffNode[]; total: number; label: string }) {
  return <div><h5>{label} · {total} 个</h5><ul>{nodes.map((node, i) => <li key={`${node.id}:${i}`}><strong>{nodeLabel(node)}</strong>
    <span>{short(node.text || "无文字")} · 留证编号 #{short(node.id)}</span></li>)}</ul>{total > nodes.length && <p>仅列前 {nodes.length} 个，全部保持未确认。</p>}</div>;
}

export function DebugReportStepDiff({ diff, taskCheck = false }: { diff: DebugSnapshotDiff; taskCheck?: boolean }) {
  const counts = diff.counts;
  return <section className="debug-step-diff" aria-label={taskCheck ? "两次验收观察差异" : "步骤前后差异"} data-diff-status={diff.status}>
    <div className="debug-step-diff-heading"><h4>{taskCheck ? "两次验收观察差异" : "步骤前后差异"}</h4><span>{statusLabel[diff.status]}</span></div>
    {diff.status === "unavailable" ? <p className="debug-step-diff-reason" role="status">{diff.reason}</p> : <>
      <p>按同一页面实例、窗口中的唯一资源 ID 比较记录；资源 ID 代表逻辑控件。</p>
      <dl className="debug-step-diff-counts">{([ ["新增", counts.added], ["消失", counts.removed], ["属性变化", counts.changed], ["可比属性无变化", counts.unchanged] ] as const)
        .map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{count}</dd></div>)}</dl>
      {diff.warnings.length > 0 && <ul className="debug-step-diff-warnings">{diff.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
      {diff.changes.length ? <details className="debug-step-diff-changes" open><summary>查看确认变化 · {diff.totalChanges} 个</summary>
        <ol tabIndex={0} aria-label="已确认的历史记录变化">{diff.changes.map((change, i) => <ChangeRow key={`${change.kind}:${i}`} change={change} taskCheck={taskCheck} />)}</ol>
      </details> : <p className="debug-step-diff-empty">{diff.status === "partial" ? "已确认匹配的节点未发现可比较属性变化；未确认部分仍未知。" : "已匹配的节点未发现属性变化。"}</p>}
      {(counts.unmatchedBefore > 0 || counts.unmatchedAfter > 0) && <details className="debug-step-diff-unmatched"><summary>未确认匹配 · 前 {counts.unmatchedBefore} 个 / 后 {counts.unmatchedAfter} 个</summary>
        <p>这些编号仅用于查阅各自留证，不能用于跨树匹配。</p><div className="debug-step-diff-unmatched-list">
          <UnmatchedNodes nodes={diff.unmatched.before} total={counts.unmatchedBefore} label={taskCheck ? "第1次观察" : "操作前"} />
          <UnmatchedNodes nodes={diff.unmatched.after} total={counts.unmatchedAfter} label={taskCheck ? "第2次观察" : "操作后"} />
        </div></details>}
    </>}
    <p className="debug-step-diff-boundary">差异仅用于查阅历史观察，不改变 Checker 验收结果，也不代表手机当前状态。</p>
  </section>;
}
