import { useEffect, useMemo, useRef, useState } from "react";
import type { UiSnapshot } from "../../../shared/types";
import { validBounds } from "../../../shared/screen-coordinates";
import { diagnoseSelectorMatches, exactSelectorMatchNode, SELECTOR_DIAGNOSTIC_FIELDS, SELECTOR_DIAGNOSTIC_LIMITS,
  type DebugSelector, type SelectorMatchCandidate } from "./selector-match-diagnostics";
import "./selector-match-diagnostics.css";

export type SelectorMatchDiagnosticsProps = {
  snapshot: UiSnapshot | null;
  selector: DebugSelector;
  onSelectMatch?: (nodeId: string, sourceSnapshot: UiSnapshot) => void;
};

const sources = { uiautomator: "UIAutomator", "accessibility-helper": "无障碍 Helper", "debug-view": "Debug View",
  "debug-qml": "Debug QML", "debug-hybrid": "Debug Hybrid" };
function display(value: string | null) {
  if (value === null) return "未记录";
  const shortened = value.length > SELECTOR_DIAGNOSTIC_LIMITS.displayedText;
  return JSON.stringify(value.slice(0, SELECTOR_DIAGNOSTIC_LIMITS.displayedText)) + (shortened ? "…（展示已截短）" : "");
}

function Candidate({ candidate, exact, onSelect }: { candidate: SelectorMatchCandidate; exact: boolean; onSelect?: () => void }) {
  const node = candidate.node, bounds = node.bounds;
  const safeId = node.id.length <= 2048 ? node.id : undefined;
  return <li className="selector-candidate" data-selector-match={exact ? "exact" : "reference"} data-node-id={safeId}>
    <div className="selector-candidate-heading">
      <strong>{exact ? "精确匹配" : "参考候选"}</strong>
      {exact && <button type="button" data-selector-action="select" data-node-id={safeId}
        aria-label={`查看精确匹配控件 ${node.id.slice(0, 128)}`} disabled={!candidate.navigable || !onSelect} onClick={onSelect}>查看控件</button>}
    </div>
    <dl className="selector-candidate-fields">
      {SELECTOR_DIAGNOSTIC_FIELDS.map(({ key, label }) => <div key={key}><dt>{label}</dt><dd>{display(node[key])}</dd></div>)}
      <div><dt>包名</dt><dd>{display(node.package)}</dd></div>
      <div><dt>位置</dt><dd>{bounds && validBounds(bounds) ? `${bounds.left}, ${bounds.top} → ${bounds.right}, ${bounds.bottom}` : "未记录或无效"}</dd></div>
      <div><dt>状态</dt><dd>{node.visibleToUser ? "可见" : "隐藏"} · {node.enabled ? "启用" : "禁用"} · {node.clickable ? "可点击" : "不可点击"}</dd></div>
    </dl>
    {exact && candidate.navigationReason && <p className="selector-candidate-note">{candidate.navigationReason}</p>}
    {candidate.refinements.length > 0 && <p className="selector-candidate-note">可对照未限制字段：{SELECTOR_DIAGNOSTIC_FIELDS.filter(field => candidate.refinements.includes(field.key)).map(field => field.label).join("、")}。需手动细化，不能保证其他页面唯一。</p>}
    {!exact && <ul className="selector-candidate-mismatches">{candidate.mismatches.map(item => <li key={item.field}>
      <span>{SELECTOR_DIAGNOSTIC_FIELDS.find(field => field.key === item.field)!.label}不匹配</span>
      <dl><div><dt>条件</dt><dd>{display(item.expected)}</dd></div><div><dt>实际</dt><dd>{display(item.actual)}</dd></div></dl>
      {item.similarity && <p className="selector-candidate-note">{item.similarity}。</p>}
    </li>)}</ul>}
  </li>;
}

export function SelectorMatchDiagnostics(props: SelectorMatchDiagnosticsProps) {
  const { snapshot, selector, onSelectMatch } = props;
  const report = useMemo(() => diagnoseSelectorMatches(snapshot, selector), [snapshot, selector]);
  const current = useRef(props), mounted = useRef(true);
  current.current = props;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [selectionIssue, setSelectionIssue] = useState<{ snapshot: UiSnapshot; selector: DebugSelector } | null>(null);
  const select = (nodeId: string) => {
    const latest = current.current;
    if (!mounted.current || !snapshot || latest.snapshot !== snapshot || latest.selector !== selector) return;
    if (!exactSelectorMatchNode(snapshot, selector, nodeId)) { setSelectionIssue({ snapshot, selector }); return; }
    latest.onSelectMatch?.(nodeId, snapshot);
  };
  const ready = report.status === "ready";
  const summary = ready ? `精确匹配 ${report.exactCount} 个` : report.status === "invalid-selector" ? "待填写条件" : "无法诊断";
  return <details className="selector-match-diagnostics" data-selector-diagnostic={report.status}>
    <summary><span>控件匹配诊断</span><span className="selector-diagnostic-count">{summary}</span></summary>
    <div className="selector-diagnostic-body">
      {!ready ? <p className="selector-diagnostic-message" role={report.status === "unavailable" ? "alert" : "status"}>{report.reason}</p> : <>
        <p className="selector-diagnostic-source">工作台快照 · 设备 {display(snapshot!.serial)} · 根包名 {display(snapshot!.root!.package)} · {snapshot!.inspectionSource ? sources[snapshot!.inspectionSource] : "来源未记录（旧快照）"} · {report.visitedNodes.toLocaleString()} 个控件</p>
        <p className="selector-diagnostic-message">{report.exactCount === 0 ? "没有控件同时符合全部已填写字段。" : report.exactCount === 1 ? "这份快照中有一个控件符合全部已填写字段。" : "这些控件都符合全部已填写字段；请选择要查看的控件，再手动细化条件。"}</p>
        <p className="selector-diagnostic-note">包含隐藏或禁用控件；这里只比较精确属性，不能替代 Checker 的两次新观察验收，也不能说明手机当前状态。位置仅用于本快照展示。</p>
        {report.ambiguity.length > 0 && <ul className="selector-diagnostic-ambiguity">{report.ambiguity.map(message => <li key={message}>{message}</li>)}</ul>}
        {report.exact.length > 0 && <ol className="selector-candidate-list" aria-label="精确匹配控件" tabIndex={0}>{report.exact.map((candidate, index) => <Candidate key={index} candidate={candidate} exact
          onSelect={onSelectMatch ? () => select(candidate.node.id) : undefined} />)}</ol>}
        {report.exactCount > report.exact.length && <p className="selector-diagnostic-note">已展示前 {report.exact.length} 个精确结果，共 {report.exactCount} 个。请增加精确字段缩小范围。</p>}
        {report.references.length > 0 && <section className="selector-diagnostic-references" aria-label="参考候选">
          <h4>参考候选 · 不算匹配</h4>
          <p className="selector-diagnostic-note">按相同字段或相似字符提供对照；不会自动修改条件，也不提供选择操作。已展示 {report.references.length} / {report.referenceCount} 个。</p>
          <ol className="selector-candidate-list" aria-label="不匹配的参考控件" tabIndex={0}>{report.references.map((candidate, index) => <Candidate key={index} candidate={candidate} exact={false} />)}</ol>
        </section>}
        {!report.exactCount && !report.referenceCount && <p className="selector-diagnostic-note">没有足够相近的参考控件。可检查包名和快照来源，再对照工作台属性手动填写。</p>}
        {report.warnings.length > 0 && <ul className="selector-diagnostic-warnings">{report.warnings.map(message => <li key={message}>{message}</li>)}</ul>}
      </>}
      {selectionIssue?.snapshot === snapshot && selectionIssue.selector === selector && <p className="selector-diagnostic-message" role="status">控件记录已变化，无法安全定位。请重新检查当前快照和条件。</p>}
    </div>
  </details>;
}
