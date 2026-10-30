import { useId } from "react";
import type { NodeHistoryControlsState } from "../features/inspection/node-visit-history";
import "../styles/node-history.css";

export function NodeHistoryControls({ history }: { history: NodeHistoryControlsState }) {
  const hint = useId();
  return <nav className="node-history-controls" aria-label="查看过的控件">
    {([[-1, "上一个查看控件", history.canBack, history.backLabel, history.back], [1, "下一个查看控件", history.canForward, history.forwardLabel, history.forward]] as const).map(([direction, label, available, name, navigate]) => {
      const reason = history.disabledReason || (!available ? direction < 0 ? "没有更早查看的控件" : "没有后续查看的控件" : null);
      const title = reason ? `${label}：${reason}` : `${label}：${name}`;
      return <span key={direction} className="node-history-control" tabIndex={reason ? 0 : undefined} title={title} aria-label={reason ? title : undefined}>
        <button type="button" className={direction < 0 ? "node-history-back" : "node-history-forward"} disabled={Boolean(reason)}
          aria-label={label} aria-describedby={hint} title={title} onClick={navigate}>
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d={direction < 0 ? "M10 3 5 8l5 5" : "m6 3 5 5-5 5"} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </span>;
    })}
    <span id={hint} className="node-history-description">在当前快照内查看前后控件</span>
  </nav>;
}
