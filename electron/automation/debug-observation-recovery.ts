export const OBSERVATION_RECOVERY_LIMITS = { extraReads: 2, timeoutMs: 15_000 } as const;

/** One budget per step, shared by action observation, verification and scrolling. */
export class ObservationRecoveryBudget {
  private deadline: number | undefined;
  private retries = 0;
  constructor(private readonly now = () => performance.now()) {}

  get remainingMs() { return this.deadline === undefined ? Infinity : Math.max(0, this.deadline - this.now()); }

  reserveRetry(): boolean {
    if (this.retries >= OBSERVATION_RECOVERY_LIMITS.extraReads || this.remainingMs <= 0) return false;
    this.deadline ??= this.now() + OBSERVATION_RECOVERY_LIMITS.timeoutMs;
    this.retries++;
    return true;
  }
}

export class ObservationRecoveryTimeoutError extends Error {
  constructor() { super("只读恢复已达到 15 秒上限，未验证成功；没有重新发送操作。"); }
}
