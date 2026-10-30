import { useId, useLayoutEffect, useState } from "react";
import { ORBIT_PARAMETER_LIMITS, parseOrbitParameter, type OrbitParameter } from "../../../shared/orbit-camera";

export function OrbitParameterInput({ parameter, value, onChange }: { parameter: OrbitParameter; value: number; onChange: (value: number) => void }) {
  const id = useId(), [draft, setDraft] = useState(String(value)), [error, setError] = useState<string | null>(null);
  const { min, max, step } = ORBIT_PARAMETER_LIMITS[parameter];
  const label = parameter === "layerGap" ? "层间距" : "视距", ariaLabel = parameter === "layerGap" ? "3D 层间距" : "3D 相机视距";
  const dirty = draft !== String(value);
  const revert = () => { setDraft(String(value)); setError(null); };
  useLayoutEffect(revert, [value]);
  const commit = (text: string) => {
    const result = parseOrbitParameter(parameter, text, value);
    setError(result.error);
    if (result.value !== null) { setDraft(String(result.value)); if (result.value !== value) onChange(result.value); }
  };
  return <div className={`layer-camera-parameter ${parameter === "layerGap" ? "layer-gap-label" : "layer-perspective-label"}`}>
    <label htmlFor={id}><span>{label}</span><span className="layer-camera-number">
      <input id={id} type="text" inputMode="numeric" aria-label={`${ariaLabel}数值`} value={draft} data-canvas-draft={dirty ? "true" : undefined}
        aria-invalid={Boolean(error)} aria-describedby={`${id}-hint`} onChange={event => { setDraft(event.target.value); setError(null); }} onBlur={revert}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); commit(draft); }
          else if (event.key === "Escape" && dirty) { event.preventDefault(); event.stopPropagation(); revert(); }
        }} /><span aria-hidden="true">px</span>
    </span></label>
    <input type="range" min={min} max={max} step={step} value={value} aria-label={ariaLabel} onChange={event => commit(event.target.value)} />
    <p id={`${id}-hint`} className={error ? "layer-camera-input-error" : "layer-camera-input-hint"} role={error ? "status" : undefined}>
      {error ?? `${min}–${max} px · 步长 ${step} · Enter 应用`}
    </p>
  </div>;
}
