import { useId } from "react";
import { CanvasToolPopover } from "../features/layers/CanvasToolPopover";
import "../styles/continuous-zoom.css";

export function ContinuousZoom({ value, min, max, disabled, onChange, open, onOpenChange }: {
  value: number; min: number; max: number; disabled: boolean; onChange: (value: number) => void; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  return <CanvasToolPopover className="zoom-continuous" bodyClassName="zoom-continuous-popup" label="连续缩放" bodyLabel="连续缩放设置" summaryClassName="zoom-continuous-toggle"
    open={open} disabled={disabled} onOpenChange={onOpenChange} title="展开连续缩放；方向键按 1% 微调"
    summary={<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d="M2 5h12M2 11h12" /><circle cx="6" cy="5" r="2" fill="var(--ref-panel)" /><circle cx="10" cy="11" r="2" fill="var(--ref-panel)" /></svg>}>
      <label htmlFor={`${id}-range`}>连续缩放 <output>{Math.round(value * 100)}%</output></label>
      <input id={`${id}-range`} type="range" aria-label="截图连续倍率" aria-valuetext={`${Math.round(value * 100)}%`}
        min={min * 100} max={max * 100} step={1} value={value * 100} disabled={disabled}
        onInput={event => onChange(Number(event.currentTarget.value) / 100)} />
      <div className="zoom-continuous-limits"><span>{min * 100}%</span><span>{max * 100}%</span></div>
      <p>拖动调整 · 方向键微调 · Esc 收起</p>
  </CanvasToolPopover>;
}
