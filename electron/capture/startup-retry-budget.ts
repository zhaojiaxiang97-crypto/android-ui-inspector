export class StartupRetryBudgetError extends Error {
  constructor() { super("App 启动重试的总预算已耗尽，已停止取图；请等待页面稳定后重新采集。"); }
}

/** Only retried attempts share the remaining request budget; normal capture is unchanged. */
export function startupRetryBudget(remainingMs: number, parent?: AbortSignal) {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) throw new StartupRetryBudgetError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new StartupRetryBudgetError()), Math.ceil(remainingMs));
  return { signal: parent ? AbortSignal.any([parent, controller.signal]) : controller.signal,
    dispose: () => clearTimeout(timer) };
}
