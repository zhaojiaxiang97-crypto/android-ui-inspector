import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { nodeDisplayLabel } from "../../../shared/tree-utils";
import { QUICK_SELECT_PAGE_SIZE, type QuickSelectCandidate, type QuickSelectResult } from "./quick-select";
import type { Rect } from "./types";
import "../../styles/quick-select.css";

type Props = {
  result: QuickSelectResult | null; disabled?: boolean; viewport?: Rect;
  onPreview: (candidate: QuickSelectCandidate | null) => void;
  onConfirm: (candidate: QuickSelectCandidate) => void;
  onPage: (page: number) => void; onClose: () => void;
};

export function QuickSelectPanel({ result, disabled, viewport, onPreview, onConfirm, onPage, onClose }: Props) {
  const panelRef = useRef<HTMLElement>(null);
  let placement: CSSProperties | undefined;
  if (viewport) {
    if ([viewport.left, viewport.top, viewport.width, viewport.height].every(Number.isFinite)) {
      const insetX = Math.min(12, Math.max(0, viewport.width / 4)), insetY = Math.min(12, Math.max(0, viewport.height / 4));
      const width = Math.max(0, Math.min(340, viewport.width - 2 * insetX)), height = Math.max(0, viewport.height - 2 * insetY);
      placement = { left: viewport.left + viewport.width - insetX - width, top: viewport.top + insetY,
        right: "auto", width, maxWidth: width, maxHeight: height,
        padding: Math.max(0, Math.min(12, (width - 2) / 2, (height - 2) / 2)), visibility: width >= 2 && height >= 2 ? "visible" : "hidden" };
    } else placement = { visibility: "hidden" };
  }
  useLayoutEffect(() => {
    if (result?.candidates.length) panelRef.current?.querySelector<HTMLButtonElement>(".quick-select-candidate")?.focus({ preventScroll: true });
  }, [result]);
  return <section ref={panelRef} className="quick-select-panel" style={placement} role="dialog" aria-label="选择内部控件" aria-describedby="quick-select-help"
    onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
    onPointerMove={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }} onWheel={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const buttons = [...panelRef.current!.querySelectorAll<HTMLButtonElement>(".quick-select-candidate")];
      const index = buttons.indexOf(event.target as HTMLButtonElement);
      if (index < 0) return;
      event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
    }} onMouseLeave={() => onPreview(null)}>
    <header><h3>选择内部控件</h3><button type="button" className="quick-select-close" onClick={onClose} aria-label="关闭内部控件选择" title="关闭 · Esc">×</button></header>
    <p id="quick-select-help" className="quick-select-help" role="status">{result?.message ?? "点选一块折叠画面，查看该位置的内部控件。Esc 退出。"}</p>
    {result?.branch && <p className="quick-select-branch" title={nodeDisplayLabel(result.branch)}>{nodeDisplayLabel(result.branch)}{result.point && <span> · {Math.round(result.point.x)}, {Math.round(result.point.y)} px</span>}</p>}
    {result?.status === "ready" && <>
      <div className="quick-select-count">{result.total} 个匹配{result.unsupported > 0 && <span title="这些节点的变换或裁剪不能可靠映射，未加入候选。"> · 跳过 {result.unsupported} 条无法映射的分支</span>}</div>
      {result.candidates.length > 0 && <ol className="quick-select-candidates" start={result.page * QUICK_SELECT_PAGE_SIZE + 1}>
        {result.candidates.map(candidate => <li key={candidate.node.id}>
          <button className="quick-select-candidate" type="button" disabled={disabled} data-quick-select-id={candidate.node.id}
            title={`${candidate.label}\n${candidate.node.className ?? candidate.className}\n${candidate.path}\n${candidate.node.resourceId || candidate.node.id}`}
            onMouseEnter={() => onPreview(candidate)} onFocus={() => onPreview(candidate)} onBlur={() => onPreview(null)} onClick={() => onConfirm(candidate)}>
            <strong>{candidate.label}</strong><small>{candidate.className}</small><span>{candidate.path}</span>
          </button>
        </li>)}
      </ol>}
      {result.pages > 1 && <nav className="quick-select-pages" aria-label="内部控件候选分页">
        <button type="button" disabled={disabled || result.page === 0} onClick={() => onPage(result.page - 1)}>上一页</button>
        <span>{result.page + 1} / {result.pages} · 每页 {QUICK_SELECT_PAGE_SIZE} 项</span>
        <button type="button" disabled={disabled || result.page + 1 >= result.pages} onClick={() => onPage(result.page + 1)}>下一页</button>
      </nav>}
    </>}
  </section>;
}
