import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { FocusUnavailableError, type getDebugTarget } from "../electron/device/target";

type Target = Awaited<ReturnType<typeof getDebugTarget>>;

// Only observe the one requested navigation; never repeat navigation or capture.
export async function waitForSessionProbeRestoration(
  previous: Target, read: (signal: AbortSignal) => Promise<Target>,
  signal = AbortSignal.timeout(3000),
): Promise<Target> {
  while (true) {
    signal.throwIfAborted();
    try {
      const restored = await read(signal);
      signal.throwIfAborted();
      assert.equal(restored.packageName, previous.packageName);
      assert.equal(restored.component, previous.component);
      assert.equal(restored.windowId, previous.windowId);
      return restored;
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof FocusUnavailableError) || error.focusReason !== "null-focus") throw error;
    }
    await wait(100, undefined, { signal });
  }
}
