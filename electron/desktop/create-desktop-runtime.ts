import { createWindowOperationScope } from "./window-operation-scope";

export interface DesktopRuntimeDependencies {
  stopSharing(reason: string): void;
  settleDebug(): Promise<unknown> | undefined;
  closeProviderSessions(): Promise<void>;
  disposePreviews(reason: "app-quit"): Promise<unknown>;
  reportShutdownError(error: unknown): void;
}

/** The process owns shutdown; windows own their operations. Provider connections close last. */
export function createDesktopRuntime(dependencies: DesktopRuntimeDependencies) {
  function report(error: unknown) {
    try { dependencies.reportShutdownError(error); } catch (reportError) { console.error("Unable to report shutdown failure", reportError); }
  }
  const operations = createWindowOperationScope(report);
  const windows = new Map<number, (reason: "window-reloaded" | "window-closed" | "app-quit") => void>();
  let disposal: Promise<void> | undefined;
  let quitting = false;
  let readyToQuit = false;
  function registerWindow(owner: number, invalidate: (reason: "window-reloaded" | "window-closed" | "app-quit") => void) {
    operations.assertAvailable(owner);
    windows.set(owner, invalidate);
  }
  function releaseWindow(owner: number, reason: "window-reloaded" | "window-closed") {
    try { windows.get(owner)?.(reason); } catch (error) { report(error); }
    if (reason === "window-closed") {
      windows.delete(owner);
      return operations.close(owner);
    }
    operations.cancel(owner);
    return operations.settled(owner);
  }
  function dispose() {
    if (disposal) return disposal;
    quitting = true;
    let operationsDone: Promise<void>;
    // Defer callbacks until disposal is assigned, so reentrant quit attempts share it.
    disposal = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      const safely = async (action: () => unknown) => { try { await action(); } catch (error) { failures.push(error); } };
      await safely(() => dependencies.stopSharing("程序退出，停止自动调试"));
      for (const invalidate of windows.values()) await safely(() => invalidate("app-quit"));
      windows.clear();
      await Promise.all([safely(() => operationsDone), safely(() => dependencies.disposePreviews("app-quit")), safely(() => dependencies.settleDebug())]);
      // A canceled capture may still establish a Provider session before its finally finishes.
      await safely(() => dependencies.closeProviderSessions());
      // A cleanup failure must be reported, but must not trap the user in an unquittable app.
      for (const error of failures) report(error);
      readyToQuit = true;
    });
    operationsDone = operations.dispose();
    return disposal;
  }
  function beforeQuit(event: { preventDefault(): void }, quit: () => void) {
    if (readyToQuit) return;
    event.preventDefault();
    if (quitting) return;
    void dispose().then(quit);
  }
  return { operations, registerWindow, releaseWindow, dispose, beforeQuit, get quitting() { return quitting; } };
}
