import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSafeSoftwareSdkCapture } from "../electron/sdk/capture-protocol";
import { captureSdkRefLayers } from "../electron/capture/sdk-images";
import type { ProviderClient } from "../electron/sdk/provider-session";
import type { UiNode } from "../shared/types";
const provider: ProviderClient = {
  open: async () => { throw new Error("unexpected provider open"); },
  call: async () => { throw new Error("unexpected provider call"); },
};
const window = (native?: string, version?: string, sdk?: string) => ({
  attributes: { "sdk-ui-wake-version": version, "sdk-window-hardware-accelerated": sdk },
  children: [{ attributes: { "hardware-accelerated": native } }],
}) as unknown as UiNode;
test("old SDK software captures reject before provider dispatch, without blocking hardware/unknown legacy windows", async () => {
  for (const version of [undefined, "", "0", "2"]) {
    assert.throws(() => assertSafeSoftwareSdkCapture(window("false", version)), /软件窗口需要新版 SDK/);
    await assert.rejects(() => captureSdkRefLayers(provider, "must-not-run-adb", "fixture", "sample", window("false", version), []), /软件窗口需要新版 SDK/);
  }
  assert.doesNotThrow(() => assertSafeSoftwareSdkCapture(window("false", "1")));
  assert.doesNotThrow(() => assertSafeSoftwareSdkCapture(window("true")));
  assert.doesNotThrow(() => assertSafeSoftwareSdkCapture(window()));
  assert.throws(() => assertSafeSoftwareSdkCapture(window(undefined, undefined, "false")), /软件窗口/);
  assert.throws(() => assertSafeSoftwareSdkCapture(window("false", undefined, "true")), /软件窗口/, "native false takes precedence over stale SDK true");
});
