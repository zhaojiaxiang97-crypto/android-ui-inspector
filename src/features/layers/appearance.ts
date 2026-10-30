import type { OrbitRotationMode } from "../../../shared/orbit-camera";

// A workspace reading mode, deliberately separate from saved appearance.
export type LayerDisplayMode = "images" | "wireframe";

export type LayerAppearance = {
  showOutlines: boolean;
  showEmpty: boolean;
  showInvisible: boolean;
  showOffscreen: boolean;
  highlightStrength: "light" | "medium" | "strong";
  rotationMode: OrbitRotationMode;
  structureMode: "regular" | "complete";
};

export const LAYER_APPEARANCE_STORAGE_KEY = "android-ui-inspector.layer-appearance";
export const DEFAULT_LAYER_APPEARANCE: LayerAppearance = { showOutlines: true, showEmpty: false, showInvisible: false, showOffscreen: false, highlightStrength: "light", rotationMode: "free", structureMode: "regular" };

export const LAYER_OUTLINE_COLORS = { dark: [160 / 255, 168 / 255, 189 / 255], light: [0.36, 0.40, 0.46] } as const;

export function parseLayerAppearance(value: unknown): LayerAppearance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_LAYER_APPEARANCE;
  const saved = value as Record<string, unknown>;
  return {
    showOutlines: typeof saved.showOutlines === "boolean" ? saved.showOutlines : DEFAULT_LAYER_APPEARANCE.showOutlines,
    showEmpty: typeof saved.showEmpty === "boolean" ? saved.showEmpty : DEFAULT_LAYER_APPEARANCE.showEmpty,
    showInvisible: typeof saved.showInvisible === "boolean" ? saved.showInvisible : DEFAULT_LAYER_APPEARANCE.showInvisible,
    showOffscreen: typeof saved.showOffscreen === "boolean" ? saved.showOffscreen : DEFAULT_LAYER_APPEARANCE.showOffscreen,
    highlightStrength: saved.highlightStrength === "light" || saved.highlightStrength === "medium" || saved.highlightStrength === "strong"
      ? saved.highlightStrength : DEFAULT_LAYER_APPEARANCE.highlightStrength,
    rotationMode: saved.rotationMode === "free" || saved.rotationMode === "horizontal"
      ? saved.rotationMode : DEFAULT_LAYER_APPEARANCE.rotationMode,
    structureMode: saved.structureMode === "regular" || saved.structureMode === "complete"
      ? saved.structureMode : DEFAULT_LAYER_APPEARANCE.structureMode,
  };
}
