// AbortSignal exposes cancellation, not its deadline. Keep only deadlines created by this process.
const deadlines = new WeakMap<AbortSignal, number>();

export function trackSignalDeadline(signal: AbortSignal, deadline: number, parents: Array<AbortSignal | undefined> = []): AbortSignal {
  if (!Number.isFinite(deadline)) throw new Error("Signal deadline must be finite");
  const inherited = parents.map(parent => parent ? deadlines.get(parent) ?? Infinity : Infinity);
  deadlines.set(signal, Math.min(deadline, deadlines.get(signal) ?? Infinity, ...inherited));
  return signal;
}

export function remainingSignalBudget(signal: AbortSignal): number | undefined {
  const deadline = deadlines.get(signal);
  return deadline === undefined ? undefined : Math.max(0, deadline - performance.now());
}
