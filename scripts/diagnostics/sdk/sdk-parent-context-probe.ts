// Read-only: bun scripts/diagnostics/sdk/sdk-parent-context-probe.ts SERIAL DEBUG_PACKAGE resource_id [resource_id...]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCaptureGeometryEvidence } from "../../../electron/capture/layer-images";
import { parseCapturedViewLayers } from "../../../electron/capture/view-protocol";

const [serial, pkg, ...ids] = process.argv.slice(2);
if (!serial || !/^[\w.:-]+$/.test(serial) || !pkg || !/^[\w.]+$/.test(pkg) || ids.length < 1 || ids.length > 8
  || new Set(ids).size !== ids.length || ids.some(id => id.length > 256 || !/^[\w.:/-]+$/.test(id))) {
  throw new Error("Usage: bun scripts/diagnostics/sdk/sdk-parent-context-probe.ts SERIAL DEBUG_PACKAGE resource_id [resource_id...] (max 8)");
}
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { timeout: 30_000, maxBuffer: 64_000_001 });
const field = (reply: string, name: string) => new RegExp(`\\b${name}=([^,}\\]]+)`).exec(reply)?.[1];
const treeReply = adb("shell", "content", "call", "--uri", `content://${pkg}.inspector`, "--method", "capture").toString();
assert.equal(field(treeReply, "result"), "ok", treeReply);
type Node = { ref: string; resourceId?: string; screenX: number; screenY: number; width: number; height: number; visible: boolean; children: Node[] };
const report = JSON.parse(adb("exec-out", "run-as", pkg, "head", "-c", "4000001", "no_backup/inspector-hierarchy.json").toString()) as { packageName: string; processInstance: string; root: Node };
assert.equal(report.packageName, pkg);
const nodes = new Map<string, Node>();
const pending = [report.root];
while (pending.length) {
  const node = pending.pop()!;
  assert.ok(!nodes.has(node.ref), "Duplicate object identity");
  nodes.set(node.ref, node);
  pending.push(...node.children);
}
const targets = ids.map(id => {
  const matches = [...nodes.values()].filter(node => (node.resourceId === id || node.resourceId?.endsWith("/" + id))
    && node.visible && node.width > 0 && node.height > 0
    && node.screenX + node.width > report.root.screenX && node.screenY + node.height > report.root.screenY
    && node.screenX < report.root.screenX + report.root.width && node.screenY < report.root.screenY + report.root.height);
  assert.equal(matches.length, 1, `Need one visible instance for ${id}, got ${matches.length}`);
  return matches[0];
});
const refs = targets.map(node => node.ref);
const directory = fileURLToPath(new URL(`../../../.benchmarks/sdk-parent-context/${new Date().toISOString().replace(/[:.]/g, "-")}/`, import.meta.url));
mkdirSync(directory, { recursive: true });
console.log(`Parent context evidence: ${directory}`);
const results: unknown[] = [];
try {
  for (let round = 0; round < 3; round++) {
    const nonce = randomBytes(8).toString("hex");
    const reply = adb("shell", "content", "call", "--uri", `content://${pkg}.inspector`, "--method", "capture-refs", "--arg", `'${refs.join(";")}'`,
      "--extra", `nonce:s:${nonce}`, "--extra", "geometryEvidence:b:true").toString();
    assert.equal(field(reply, "result"), "ok", reply);
    assert.equal(field(reply, "nonce"), nonce);
    assert.equal(field(reply, "processInstance"), report.processInstance);
    assert.equal(field(reply, "rootRef"), report.root.ref);
    assert.ok(field(reply, "geometryEvidence"), "SDK must be rebuilt with same-task parent evidence support");
    const file = adb("exec-out", "run-as", pkg, "head", "-c", "64000001", "no_backup/inspector-ref-layers.bin");
    assert.equal(file.length, Number(field(reply, "bytes")));
    assert.equal(file.subarray(0, 8).toString("hex"), nonce);
    assert.equal(createHash("sha256").update(file).digest("hex"), field(reply, "sha256"));
    const images = parseCapturedViewLayers(file);
    assert.equal(images.length, Number(field(reply, "count")));
    const geometry = parseCaptureGeometryEvidence(field(reply, "geometryEvidence"), refs, report.root.ref);
    assert.equal(images.length, geometry.size, "Selected ordinary Views must have matching image evidence");
    const layers = images.map(image => {
      const evidence = geometry.get(image.name)!;
      assert.ok(evidence, "Unexpected or duplicate image identity");
      geometry.delete(image.name);
      assert.deepEqual(evidence.chain[0].slice(2, 6), [image.x, image.y, image.width, image.height]);
      return { ref: image.name, resourceId: nodes.get(image.name)?.resourceId, evidence,
        treeDeltas: evidence.chain.map(row => {
          const old = nodes.get(row[0] as string);
          return { ref: row[0], dx: old ? (row[2] as number) - old.screenX : null, dy: old ? (row[3] as number) - old.screenY : null,
            sameSize: old ? row[4] === old.width && row[5] === old.height : null };
        }) };
    });
    const result = { round: round + 1, layers, failures: field(reply, "failures"), renderMs: Number(field(reply, "renderMs")) };
    results.push(result);
    writeFileSync(`${directory}/evidence.json`, JSON.stringify({ packageName: pkg, processInstance: report.processInstance, results }, null, 2));
    console.log(JSON.stringify(result)); // Metadata only, never image pixels or business text.
    assert.equal(layers.length, refs.length, "A selected View had no ordinary image; inspect saved failures");
  }
} finally {
  adb("shell", "run-as", pkg, "rm", "-f", "no_backup/inspector-ref-layers.bin");
}
