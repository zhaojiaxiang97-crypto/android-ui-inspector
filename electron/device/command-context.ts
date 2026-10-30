import { AsyncLocalStorage } from "node:async_hooks";

// Device commands inherit cancellation only. Capture policy belongs to callers.
const commandContext = new AsyncLocalStorage<AbortSignal | undefined>();

export function commandSignal(): AbortSignal | undefined {
  return commandContext.getStore();
}

export function withCommandSignal<T>(signal: AbortSignal | undefined, operation: () => T): T {
  return commandContext.run(signal, operation);
}

// Forward registration must finish so its allocated port can always be removed.
// Cleanup must also remain runnable after the requesting operation is cancelled.
export function withoutCommandSignal<T>(operation: () => T): T {
  return commandContext.exit(operation);
}
