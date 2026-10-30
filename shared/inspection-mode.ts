/** Capture policy, independent of input authorization and snapshot provenance. */
export type InspectionMode = "standard" | "sdk-enhanced";
export const DEFAULT_INSPECTION_MODE: InspectionMode = "standard";

export function isInspectionMode(value: unknown): value is InspectionMode {
  return value === "standard" || value === "sdk-enhanced";
}

export function inspectionModeOrDefault(value: unknown): InspectionMode {
  return isInspectionMode(value) ? value : DEFAULT_INSPECTION_MODE;
}

export interface InspectionModeState {
  mode: InspectionMode;
  revision: number;
  busy: boolean;
}
