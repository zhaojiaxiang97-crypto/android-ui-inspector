import { AppIcon } from "./AppIcon";
import { useId } from "react";
import { CanvasToolPopover } from "../features/layers/CanvasToolPopover";
import "../styles/continuous-zoom.css";

export function ContinuousZoom({ value, min, max, disabled, onChange, open, onOpenChange, presets, onReset }: {
  value: number; min: number; max: number; disabled: boolean; onChange: (value: number) => void; open: boolean; onOpenChange: (open: boolean) => void;
  presets: readonly number[]; onReset: () => void;
}) {
  const id = useId();
  const preset = presets.find(item => Math.abs(item - value) < 0.001);
  return <CanvasToolPopover className="zoom-continuous" bodyClassName="zoom-continuous-popup" label="连续缩放" bodyLabel="连续缩放设置" summaryClassName="zoom-continuous-toggle"
    open={open} disabled={disabled} onOpenChange={onOpenChange} title="展开连续缩放；方向键按 1% 微调"
    summary={<><span className="zoom-readout" aria-live="polite">{Math.round(value * 100)}%</span><AppIcon name="chevron" size={12} /></>}>
      <label htmlFor={`${id}-range`}>连续缩放 <output>{Math.round(value * 100)}%</output></label>
      <input id={`${id}-range`} type="range" aria-label="截图连续倍率" aria-valuetext={`${Math.round(value * 100)}%`}
        min={min * 100} max={max * 100} step={1} value={value * 100} disabled={disabled}
        onInput={event => onChange(Number(event.currentTarget.value) / 100)} />
      <div className="zoom-continuous-limits"><span>{min * 100}%</span><span>{max * 100}%</span></div>
      <label className="zoom-preset-row">缩放比例
        <select className="zoom-preset-select" aria-label="截图倍率预设" value={preset ? String(preset) : "custom"}
          disabled={disabled} onChange={event => { if (event.currentTarget.value !== "custom") onChange(Number(event.currentTarget.value)); }}>
          <option value="custom">{Math.round(value * 100)}%</option>
          {presets.map(item => <option value={item} key={item}>{Math.round(item * 100)}%</option>)}
        </select>
      </label>
      <p>拖动调整 · 方向键微调 · Esc 收起</p>
      <button className="zoom-reset" type="button" disabled={disabled} onClick={onReset}>重置视图</button>
  </CanvasToolPopover>;
}
