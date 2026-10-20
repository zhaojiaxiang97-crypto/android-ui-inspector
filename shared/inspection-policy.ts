export function inspectionLayerCapture(value: unknown): import("./types").LayerCaptureMode {
  if (value === undefined) return "full";
  if (value !== "on-demand" && value !== "full") throw new Error("图层采集范围无效。");
  return value;
}

/** Omission preserves the existing automatic startup retry behavior. */
export function inspectionSingleAttempt(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error("单次采集选项必须为布尔值。");
  return value;
}

export type ReadOnlyCaptureScope = { expectedPackage: string };

export function inspectionReadOnlyScope(value: unknown, singleAttempt: boolean): ReadOnlyCaptureScope | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 1 || !("expectedPackage" in value)
      || typeof value.expectedPackage !== "string" || !validDiagnosticPackage(value.expectedPackage)) {
    throw new Error("只读诊断必须指定有效的 App 包名。");
  }
  if (!singleAttempt) throw new Error("只读诊断只允许单次采集。");
  return { expectedPackage: value.expectedPackage };
}

export function validDiagnosticPackage(value: string): boolean {
  return value.length <= 200 && /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(value);
}
