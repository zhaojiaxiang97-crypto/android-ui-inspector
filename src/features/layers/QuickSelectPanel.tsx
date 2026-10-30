import { useId, useLayoutEffect, useRef, type CSSProperties } from "react";
import { nodeDisplayLabel } from "../../../shared/tree-utils";
import { QUICK_SELECT_PAGE_SIZE, quickSelectPlacement, type QuickSelectCandidate, type QuickSelectResult } from "./quick-select";
import type { Point, Rect } from "./types";
import "../../styles/quick-select.css";

type Props = {
  result: QuickSelectResult | null; disabled?: boolean; viewport?: Rect; anchor?: Point;
  onPreview: (candidate: QuickSelectCandidate | null) => void;
  onConfirm: (candidate: QuickSelectCandidate) => void;
  onPage: (page: number) => void; onFilter?: (query: string) => void; onClose: () => void;
};

export function QuickSelectPanel({ result, disabled, viewport, anchor, onPreview, onConfirm, onPage, onFilter, onClose }: Props) {
  const panelRef = useRef<HTMLElement>(null), filterRef = useRef<HTMLInputElement>(null), helpId = useId();
  let placement: CSSProperties | undefined;
  if (viewport) {
    const rect = quickSelectPlacement(viewport, anchor);
    placement = rect ? { left: rect.left, top: rect.top, right: "auto", width: rect.width, maxWidth: rect.width,
      maxHeight: rect.height, padding: Math.max(0, Math.min(12, (rect.width - 2) / 2, (rect.height - 2) / 2)),
      visibility: rect.width >= 2 && rect.height >= 2 ? "visible" : "hidden" } : { visibility: "hidden" };
  }
  useLayoutEffect(() => {
    if (document.activeElement === filterRef.current) return;
    if (result?.candidates.length) panelRef.current?.querySelector<HTMLButtonElement>(".quick-select-candidate")?.focus({ preventScroll: true });
  }, [result]);
  const filteredTotal = result?.filteredTotal ?? result?.total ?? 0;
  const first = result?.candidates.length ? result.page * QUICK_SELECT_PAGE_SIZE + 1 : 0;
  const last = result ? first + result.candidates.length - 1 : 0;
  return <section ref={panelRef} className="quick-select-panel" style={placement} role="dialog" aria-label="选择折叠内部的控件" aria-describedby={helpId}
    onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
    onPointerMove={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }} onWheel={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const buttons = [...panelRef.current!.querySelectorAll<HTMLButtonElement>(".quick-select-candidate:not(:disabled)")];
      if (!buttons.length) return;
      if (event.target === filterRef.current) {
        event.preventDefault(); buttons[event.key === "ArrowDown" ? 0 : buttons.length - 1]?.focus(); return;
      }
      const index = buttons.indexOf(event.target as HTMLButtonElement);
      if (index < 0) return;
      event.preventDefault();
      if (index === 0 && event.key === "ArrowUp" && filterRef.current) filterRef.current.focus();
      else buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
    }} onMouseLeave={() => onPreview(null)}>
    <header><h3>折叠内部的控件</h3><button type="button" className="quick-select-close" onClick={onClose} aria-label="关闭内部控件选择" title="关闭 · Esc">×</button></header>
    <p id={helpId} className="quick-select-help" role="status">{result?.message ?? "点选一块折叠画面，查看该位置的内部控件。Esc 退出。"}</p>
    {result?.branch && <div className="quick-select-branch" title={`${nodeDisplayLabel(result.branch)}\n${result.branch.className ?? ""}\n${result.branch.id}`}>
      <small>当前分支</small><strong>{nodeDisplayLabel(result.branch)}</strong>
      {result.point && <span>{Math.round(result.point.x)}, {Math.round(result.point.y)} px</span>}
    </div>}
    {result?.status === "ready" && <>
      {onFilter && <input ref={filterRef} className="quick-select-filter" type="search" value={result.query ?? ""} disabled={disabled}
        aria-label="筛选当前内部控件候选" placeholder="在这些候选中筛选…"
        title="按文本、资源 ID、类型或相对路径筛选，不改变原树"
        onChange={event => onFilter(event.target.value)} onFocus={() => onPreview(null)} />}
      <div className="quick-select-count" role="status">
        <span>{result.total} 个匹配{result.query?.trim() && ` · 筛选后 ${filteredTotal} 个`}</span>
        {result.candidates.length > 0 && <span>本页 {first}–{last}</span>}
        {result.unsupported > 0 && <span className="quick-select-skipped" title="这些节点的变换或裁剪不能可靠映射，未加入候选。">跳过 {result.unsupported} 条无法映射的分支</span>}
      </div>
      {result.candidates.length > 0 ? <ol className="quick-select-candidates" start={first}>
        {result.candidates.map(candidate => <li key={candidate.node.id}>
          <button className="quick-select-candidate" type="button" disabled={disabled} data-quick-select-id={candidate.node.id}
            title={`${candidate.label}\n${candidate.node.className ?? candidate.className}\n${candidate.path}\n${candidate.node.resourceId || candidate.node.id}`}
            onMouseEnter={() => onPreview(candidate)} onFocus={() => onPreview(candidate)} onBlur={() => onPreview(null)} onClick={() => onConfirm(candidate)}>
            <strong>{candidate.label}</strong><small>{candidate.className}</small>
            {candidate.node.resourceId && <span className="quick-select-resource">{candidate.node.resourceId}</span>}
            <span className="quick-select-path" title={candidate.path}>{candidate.relativePath && <em>{candidate.relativePath}</em>}{candidate.path}</span>
          </button>
        </li>)}
      </ol> : result.query?.trim() ? <p className="quick-select-empty">这些候选里没有匹配项。试试更短的文本或 ID。</p> : null}
      {result.pages > 1 && <nav className="quick-select-pages" aria-label="内部控件候选分页">
        <button type="button" disabled={disabled || result.page === 0} onClick={() => onPage(result.page - 1)}>上一页</button>
        <span>{result.page + 1} / {result.pages} · 每页 {QUICK_SELECT_PAGE_SIZE} 项</span>
        <button type="button" disabled={disabled || result.page + 1 >= result.pages} onClick={() => onPage(result.page + 1)}>下一页</button>
      </nav>}
    </>}
  </section>;
}
