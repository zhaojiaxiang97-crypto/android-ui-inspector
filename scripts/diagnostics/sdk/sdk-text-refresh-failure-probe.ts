// Debug-only device probe: reject stale bindings without delivering pixels, then check cleanup.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { captureSdkRefLayers } from "../../../electron/capture/sdk-images";
import { createProviderSessionPool } from "../../../electron/sdk/provider-session";
import type { UiNode } from "../../../shared/types";

const [serial, packageName, text] = process.argv.slice(2);
assert.ok(serial && /^[\w.-]+$/.test(serial) && packageName && /^[\w.]+$/.test(packageName) && text);
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { timeout: 30000, encoding: "utf8" });
const reply = adb("shell", "content", "call", "--uri", `content://${packageName}.inspector`, "--method", "capture");
assert.match(reply, /result=ok/);
const sdk = JSON.parse(adb("exec-out", "run-as", packageName, "head", "-c", "4000001", "no_backup/inspector-hierarchy.json"));
assert.equal(sdk.packageName, packageName);
assert.equal(sdk.refDebugCanvasVersion, 1);
const pending = [sdk.root];
let target: any;
const identities = new Set<string>();
while (pending.length) {
  const node = pending.pop();
  identities.add(node.ref);
  if (node.text === text && node.className.endsWith("TextView") && !node.children.length) {
    assert.equal(target, undefined, "Text target must be unique");
    target = node;
  }
  pending.push(...node.children);
}
assert.ok(target);
const root = {
  attributes: { "sdk-process-instance": sdk.processInstance, "sdk-ref-debug-canvas-version": "1" },
  children: [{ attributes: { "view-ref": sdk.root.ref } }],
} as unknown as UiNode;
const checkCleanup = () => {
  for (const file of ["no_backup/inspector-ref-layers.bin", "no_backup/inspector-ref-layers.bin.tmp"]) {
    const result = spawnSync("adb", ["-s", serial, "shell", "run-as", packageName, "test", "-e", file], { timeout: 30000 });
    assert.equal(result.status, 1, `Unexpected capture file: ${file}`);
  }
};
const provider = createProviderSessionPool();
try {
  const missing = "android.widget.TextView@deadbeef";
  assert.equal(identities.has(missing), false);
  const absent = await captureSdkRefLayers(provider, "adb", serial, packageName, root, [missing], true, "sdk-enhanced");
  assert.equal(absent.images.size, 0);
  assert.equal(absent.failures.size, 1);
  assert.ok(absent.failures.has(missing));
  checkCleanup();
  const wrongInstance = "00000000-0000-0000-0000-000000000001";
  assert.notEqual(sdk.processInstance, wrongInstance);
  await assert.rejects(() => captureSdkRefLayers(provider, "adb", serial, packageName, {
    ...root, attributes: { ...root.attributes, "sdk-process-instance": wrongInstance },
  }, [target.ref], true, "sdk-enhanced"), /SDK 补齐抓取失败/);
  checkCleanup();
  await assert.rejects(() => captureSdkRefLayers(provider, "adb", serial, packageName, {
    ...root, children: [{ attributes: { "view-ref": missing } } as unknown as UiNode],
  }, [target.ref], true, "sdk-enhanced"), /SDK 补齐抓取失败/);
  checkCleanup();
  const recovered = await captureSdkRefLayers(provider, "adb", serial, packageName, root, [target.ref], true, "sdk-enhanced");
  assert.equal(recovered.failures.size, 0);
  assert.equal(recovered.images.size, 1);
  assert.equal(recovered.images.get(target.ref)?.width, target.width);
  assert.equal(recovered.images.get(target.ref)?.height, target.height);
  checkCleanup();
  console.log(JSON.stringify({ passed: true, missingRef: true, staleProcess: true, staleRoot: true, filesCleaned: true, recovered: true }));
} finally {
  await provider.dispose();
}
