// A node refresh can legitimately update geometry. Report differences rather than
// treating the old merged-tree coordinates as a new capture's pixel oracle.
export function shouldRetryHealthCapture(error: unknown, singleAttempt: boolean) {
  return !singleAttempt && typeof error === "string" && /冷启动|等待页面稳定|尚未就绪|请等待页面就绪/.test(error);
}

export function canRefreshHealthCapture(value: any, durationMs: number, thresholdMs: number, singleAttempt: boolean) {
  if (!singleAttempt) return true; // Preserve existing diagnostic probe behavior.
  return !value?.error && !value?.diagnostics?.["sdk-visible-interrupted"]
    && Number.isFinite(durationMs) && durationMs < thresholdMs
    && ["debug-view", "debug-hybrid"].includes(value?.inspectionSource)
    && value?.coverage?.captured > 0 && value?.coverage?.failed === 0
    && value?.captureRequestDiagnostics?.totalAttempts === 1;
}

/** Bounded same-session series: stop on the first unhealthy or changed workload. */
export function canContinueHealthSeries(attempt: any, baseline: any, thresholdMs: number) {
  const value = attempt?.value, first = baseline?.value;
  return canRefreshHealthCapture(value, attempt?.duration, thresholdMs, true)
    && typeof value?.debugProcessId === "string" && /^[1-9]\d*$/.test(value.debugProcessId)
    && typeof value?.processInstance === "string" && value.processInstance.length > 0
    && typeof value?.rootRef === "string" && value.rootRef.length > 0
    && value.debugProcessId === first?.debugProcessId && value.processInstance === first?.processInstance
    && value.rootRef === first?.rootRef && value.nodeCount === first?.nodeCount
    && value.coverage.captured === first?.coverage?.captured && value.coverage.visible === first?.coverage?.visible;
}

export function validateHealthRefresh(target: any, value: any, exception?: string, expectedPixelSha?: string) {
  const keys = ["left", "top", "right", "bottom"];
  const validBounds = keys.every(key => Number.isFinite(value?.bounds?.[key]))
    && value.bounds.right > value.bounds.left && value.bounds.bottom > value.bounds.top;
  return {
    accepted: !exception && Array.isArray(value?.failures) && value.failures.length === 0
      && value.id === target.id && value.ref === target.ref && value.className === target.className
      && validBounds && value.status === "captured" && value.hasImage === true
      && (!expectedPixelSha || value.pixels?.sha256 === expectedPixelSha
        && value.pixels?.width === value.bounds.right - value.bounds.left
        && value.pixels?.height === value.bounds.bottom - value.bounds.top),
    boundsMatchBaseline: keys.every(key => value?.bounds?.[key] === target.bounds?.[key]),
  };
}
