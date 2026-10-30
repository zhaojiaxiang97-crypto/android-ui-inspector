import assert from "node:assert/strict";
import { test } from "node:test";
import { bitmapTarget } from "../electron/capture/sdk-images";
import type { ProviderClient } from "../electron/sdk/provider-session";
import type { UiNode } from "../shared/types";

function root(instance: string): UiNode {
  return { id: "root", index: null, className: "FrameLayout", package: "sample.app", text: null,
    resourceId: null, contentDesc: null, bounds: null, clickable: false, enabled: true, focusable: false,
    focused: false, scrollable: false,
    selected: false, visibleToUser: true, children: [], attributes: {
      "sdk-ui-wake-version": "1", "sdk-process-instance": instance, "debug-process-id": "42",
      "sdk-window-hardware-accelerated": "false",
    } };
}
function client(calls: Parameters<ProviderClient["call"]>[], replyInstance?: string): ProviderClient {
  return {
    open: async () => { throw new Error("Wake must use the injected request client"); },
    call: async (...args) => {
      calls.push(args);
      return { code: 0, stdout: Buffer.from(`Result: Bundle[{result=ok, nonce=${args[4]}, processInstance=${replyInstance ?? args[5]?.processInstance}, pid=42}]`), stderr: "" };
    },
  };
}

test("bitmap wake callbacks retain their explicitly supplied provider and target identity", async () => {
  const first: Parameters<ProviderClient["call"]>[] = [], second: Parameters<ProviderClient["call"]>[] = [];
  const a = bitmapTarget(client(first), "adb-a", "serial-a", "sample.app", root("process-a"), "ref-a", "window-a", "sdk-enhanced");
  const b = bitmapTarget(client(second), "adb-b", "serial-b", "sample.app", root("process-b"), "ref-b", "window-b", "sdk-enhanced");
  await Promise.all([b.wakeUi!(), a.wakeUi!()]);
  assert.equal(first.length, 1); assert.equal(second.length, 1);
  assert.deepEqual(first[0].slice(0, 4), ["adb-a", "serial-a", "sample.app", "wake-ui"]);
  assert.deepEqual(second[0].slice(0, 4), ["adb-b", "serial-b", "sample.app", "wake-ui"]);
  assert.deepEqual(first[0][5], { processInstance: "process-a" });
  assert.deepEqual(second[0][5], { processInstance: "process-b" });
  assert.equal(first[0][6], 3000); assert.match(first[0][4]!, /^[a-f0-9]{16}$/);
  assert.equal(a.hardwareAccelerated, false);
});

test("bitmap wake still rejects a reply for another SDK process", async () => {
  const calls: Parameters<ProviderClient["call"]>[] = [];
  const target = bitmapTarget(client(calls, "stale-process"), "adb", "serial", "sample.app", root("current-process"), "ref", "window", "sdk-enhanced");
  await assert.rejects(target.wakeUi!(), /SDK 安全唤醒身份校验失败/);
  assert.equal(calls.length, 1, "identity rejection must not replay a provider request");
});

test("legacy bitmap targets never create a provider wake request", () => {
  const calls: Parameters<ProviderClient["call"]>[] = [], legacy = root("legacy");
  delete legacy.attributes!["sdk-ui-wake-version"];
  assert.equal(bitmapTarget(client(calls), "adb", "serial", "sample.app", legacy, "ref", "window", "sdk-enhanced").wakeUi, undefined);
  assert.equal(calls.length, 0);
});
