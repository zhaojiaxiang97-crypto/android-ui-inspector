// Sample-only: geometry protocol and dynamic rejection. No business captures or pixel-speed claim.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { parseBranchGeometry, verifyBranchGeometryRefresh, type BranchBinding, type BranchGeometryRead } from "../../../electron/sdk/branch-geometry";

const serial = process.argv[2];
assert.ok(serial && /^[\w.:-]+$/.test(serial), "Usage: bun scripts/diagnostics/sdk/sdk-branch-geometry-probe.ts SERIAL");
const app = "com.androiduiinspector.sample";
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { timeout: 15000, maxBuffer: 1_000_000 }).toString();
const output = join(import.meta.dirname, "../../../.benchmarks/branch-geometry", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
const previous = /(?:mResumedActivity:|topResumedActivity=).*?\s([\w.]+\/[\w.$]+)\s/.exec(adb("shell", "dumpsys", "activity", "activities"))?.[1];
try {
  adb("shell", "am", "force-stop", app);
  adb("shell", "am", "start", "-n", `${app}/.MainActivity`, "--es", "mode", "resize");
  await wait(1200);
  assert.match(adb("shell", "content", "call", "--uri", `content://${app}.inspector`, "--method", "capture"), /result=ok/);
  const tree = JSON.parse(adb("exec-out", "run-as", app, "cat", "no_backup/inspector-hierarchy.json"));
  type Node = { ref: string; text?: string; className: string; children: Node[] };
  const find = (node: Node, ancestors: string[] = []): string[] | null => {
    const path = [...ancestors, node.ref];
    if (node.className.endsWith("$DecoratedParent")) return path;
    for (const child of node.children ?? []) { const result = find(child, path); if (result) return result; }
    return null;
  };
  const path = find(tree.root); assert.ok(path, "No sample parent");
  const binding: BranchBinding = { packageName: app, pid: tree.pid, processInstance: tree.processInstance, rootRef: path[0], branchRef: path.at(-1)! };
  const read = async (): Promise<BranchGeometryRead> => {
    const nonce = randomBytes(8).toString("hex");
    const reply = adb("shell", "content", "call", "--uri", `content://${app}.inspector`, "--method", "read-branch-geometry",
      "--arg", `'${path.join(";")}'`, "--extra", `nonce:s:${nonce}`);
    assert.match(reply, /result=ok/);
    const data = /\bdata=([A-Za-z0-9+/=]+)/.exec(reply)?.[1]; assert.ok(data);
    return parseBranchGeometry(data, nonce, binding, path);
  };
  const original = await read(), stable = await read();
  writeFileSync(join(output, "before.json"), JSON.stringify({ original, stable }, null, 2));
  assert.deepEqual(original.nodes, stable.nodes); assert.deepEqual(original.ancestors, stable.ancestors);
  let changed: BranchGeometryRead | undefined;
  // Only geometry placeholders here; validated image/pixel handling is covered separately by capture tests.
  await assert.rejects(verifyBranchGeometryRefresh(original, read, async () => {
    const child = original.nodes.find(row => row.ref.includes("TextView@")); assert.ok(child);
    adb("shell", "input", "tap", String(Math.round(child.x + child.width / 2)), String(Math.round(child.y + child.height / 2)));
    // Wait for the test mutation, not just input dispatch. No extra image capture or business retry.
    for (let i = 0; i < 4; i++) {
      await wait(500);
      changed = await read();
      if (changed.nodes.some((row, i) => row.width !== original.nodes[i].width)) break;
    }
    writeFileSync(join(output, "after.json"), JSON.stringify(changed, null, 2));
    assert.ok(changed && changed.nodes.some((row, i) => row.width !== original.nodes[i].width), "Sample tap did not cause resize");
    return new Map(original.nodes.map(row => [row.ref, { x: row.x, y: row.y, width: row.width, height: row.height }]));
  }), /刷新期间变化/);
  assert.ok(changed && changed.nodes.some((row, i) => row.width !== original.nodes[i].width));
  const badPath = [...path]; badPath[badPath.length - 1] = "example.Missing@1";
  assert.match(adb("shell", "content", "call", "--uri", `content://${app}.inspector`, "--method", "read-branch-geometry",
    "--arg", `'${badPath.join(";")}'`, "--extra", "nonce:s:1234567890abcdef"), /error=.*identity changed/);
  writeFileSync(join(output, "result.json"), JSON.stringify({ passed: true, original, stable, changed, geometryOnly: true }, null, 2));
  console.log(JSON.stringify({ passed: true, branchNodes: original.nodes.length, ancestors: original.ancestors.length,
    stableReadPassed: true, resizeRejected: true, missingIdentityRejected: true, output }));
} catch (error) {
  writeFileSync(join(output, "failure.txt"), String(error)); throw error;
} finally {
  if (previous && !previous.startsWith(`${app}/`)) adb("shell", "am", "start", "-n", previous);
}
