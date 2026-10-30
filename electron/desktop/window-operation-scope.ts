/** Owns cancellation and completion, without choosing business scheduling policies. */
export function createWindowOperationScope(reportCancellationError: (error: unknown) => void = error => console.error("Window cancellation failed", error)) {
  type Operation = { cancel: () => void; done: Promise<unknown>; canceled: boolean };
  const pending = new Map<number, Set<Operation>>();
  const closed = new Set<number>();
  let disposed = false;
  let disposal: Promise<void> | undefined;
  function assertAvailable(owner: number) {
    if (disposed || closed.has(owner)) throw new Error("窗口已关闭或程序正在退出。");
  }
  function track<T>(owner: number, done: Promise<T>, cancel: () => void): Promise<T> {
    let operations = pending.get(owner);
    if (!operations) pending.set(owner, operations = new Set());
    const entry = { done, cancel, canceled: false };
    operations.add(entry);
    const release = () => {
      operations.delete(entry);
      if (!operations.size && pending.get(owner) === operations) pending.delete(owner);
    };
    void done.then(release, release);
    if (disposed || closed.has(owner)) cancelOperation(entry);
    return done;
  }
  function cancelOperation(operation: Operation) {
    if (operation.canceled) return;
    operation.canceled = true;
    try { operation.cancel(); } catch (error) { reportCancellationError(error); }
  }
  function cancel(owner: number) {
    // Keep canceled entries until settled, including operations replaced by newer requests.
    for (const operation of [...pending.get(owner) ?? []]) cancelOperation(operation);
  }
  async function settled(owner?: number) {
    while (owner === undefined ? pending.size : pending.has(owner)) {
      const operations = owner === undefined ? [...pending.values()].flatMap(items => [...items]) : [...pending.get(owner) ?? []];
      await Promise.allSettled(operations.map(operation => operation.done));
    }
  }
  function close(owner: number) { closed.add(owner); cancel(owner); return settled(owner); }
  function dispose() {
    if (disposal) return disposal;
    disposed = true;
    disposal = Promise.resolve().then(() => settled());
    for (const owner of pending.keys()) cancel(owner);
    return disposal;
  }
  return { assertAvailable, track, cancel, settled, close, dispose };
}
export type WindowOperationScope = ReturnType<typeof createWindowOperationScope>;

/** Native pickers can outlive a renderer. Cancellation settles the request and ignores a late choice. */
export async function awaitDialogSelection<T>(selection: Promise<T>, signal: AbortSignal, canceled: T): Promise<T> {
  let onAbort = () => {};
  const aborted = new Promise<T>(resolve => {
    onAbort = () => resolve(canceled);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([selection, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
