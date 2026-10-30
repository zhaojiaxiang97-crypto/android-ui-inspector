export type LayerAppearance = {
  showOutlines: boolean;
  highlightStrength: "light" | "medium" | "strong";
};

export const LAYER_APPEARANCE_STORAGE_KEY = "android-ui-inspector.layer-appearance";
export const DEFAULT_LAYER_APPEARANCE: LayerAppearance = { showOutlines: true, highlightStrength: "light" };

export function parseLayerAppearance(value: unknown): LayerAppearance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_LAYER_APPEARANCE;
  const saved = value as Record<string, unknown>;
  return {
    showOutlines: typeof saved.showOutlines === "boolean" ? saved.showOutlines : DEFAULT_LAYER_APPEARANCE.showOutlines,
    highlightStrength: saved.highlightStrength === "light" || saved.highlightStrength === "medium" || saved.highlightStrength === "strong"
      ? saved.highlightStrength : DEFAULT_LAYER_APPEARANCE.highlightStrength,
  };
}
