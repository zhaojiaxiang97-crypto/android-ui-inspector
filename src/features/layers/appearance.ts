import type { OrbitRotationMode } from "../../../shared/orbit-camera";

export type LayerAppearance = {
  showOutlines: boolean;
  showInvisible: boolean;
  highlightStrength: "light" | "medium" | "strong";
  rotationMode: OrbitRotationMode;
};

export const LAYER_APPEARANCE_STORAGE_KEY = "android-ui-inspector.layer-appearance";
export const DEFAULT_LAYER_APPEARANCE: LayerAppearance = { showOutlines: true, showInvisible: false, highlightStrength: "light", rotationMode: "free" };

export function parseLayerAppearance(value: unknown): LayerAppearance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_LAYER_APPEARANCE;
  const saved = value as Record<string, unknown>;
  return {
    showOutlines: typeof saved.showOutlines === "boolean" ? saved.showOutlines : DEFAULT_LAYER_APPEARANCE.showOutlines,
    showInvisible: typeof saved.showInvisible === "boolean" ? saved.showInvisible : DEFAULT_LAYER_APPEARANCE.showInvisible,
    highlightStrength: saved.highlightStrength === "light" || saved.highlightStrength === "medium" || saved.highlightStrength === "strong"
      ? saved.highlightStrength : DEFAULT_LAYER_APPEARANCE.highlightStrength,
    rotationMode: saved.rotationMode === "free" || saved.rotationMode === "horizontal"
      ? saved.rotationMode : DEFAULT_LAYER_APPEARANCE.rotationMode,
  };
}
