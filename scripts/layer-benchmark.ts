import assert from "node:assert/strict";
import { cpus, release } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createTree, type TreeShape } from "../benchmarks/fixtures";
import { statistics } from "../benchmarks/statistics";
import { buildLayerLayout } from "../shared/layer-layout";
import type { UiNode } from "../shared/types";

const iterations = 15;
const warmups = 3;
const sizes = [1_000, 5_000, 10_000, 25_000];
const shapes: TreeShape[] = ["balanced", "wide"];
const screenshotSize = { width: 360, height: 2_400 };

function lastLeaf(root: UiNode) {
  let node = root;
  while (node.children.length > 0) node = node.children[node.children.length - 1];
  return node;
}

function depthOf(root: UiNode, targetId: string) {
  const stack: Array<{ node: UiNode; depth: number }> = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.node.id === targetId) return current.depth;
    for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: current.node.children[index], depth: current.depth + 1 });
    }
  }
  return -1;
}

function measure(operation: () => void) {
  for (let index = 0; index < warmups; index += 1) operation();
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    operation();
    samples.push(performance.now() - start);
  }
  return statistics(samples);
}

const results = shapes.flatMap((shape) => sizes.map((size) => {
  const root = createTree(size, shape);
  const selected = lastLeaf(root);
  const targetDepth = depthOf(root, selected.id);
  let focusResult = buildLayerLayout(root, selected, screenshotSize, { scope: "focus", maxChildDepth: 3, maxLayers: 96 });
  const focusTiming = measure(() => { focusResult = buildLayerLayout(root, selected, screenshotSize, { scope: "focus", maxChildDepth: 3, maxLayers: 96 }); });
  assert.ok(focusResult.records.length <= 96, `${shape}/${size}: focus layer cap exceeded`);
  assert.ok(focusResult.records.some((record) => record.isSelected), `${shape}/${size}: selected layer missing`);

  const allResult = buildLayerLayout(root, selected, screenshotSize, { scope: "all", maxDepth: 200, maxLayers: 256 });
  assert.ok(allResult.records.length <= 256, `${shape}/${size}: all-layer cap exceeded`);
  assert.equal(allResult.truncated, size > 256, `${shape}/${size}: truncation metadata is inconsistent`);

  return {
    shape,
    nodes: size,
    targetDepth,
    focusLayers: focusResult.records.length,
    focusCandidates: focusResult.candidateCount,
    allLayers: allResult.records.length,
    allCandidates: allResult.candidateCount,
    allOmitted: allResult.omittedCount,
    focusWithin16ms: focusTiming.medianMs <= 16,
    ...focusTiming,
  };
}));

const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`,
    platform: process.platform,
    os: release(),
    arch: process.arch,
    cpu: cpus()[0]?.model,
  },
  scope: "Pure LayerRecord layout only; excludes React, DOM, CSS compositing, ADB and screenshot decoding",
  iterations,
  warmups,
  screenshotSize,
  results,
};

const outputDirectory = new URL("../.benchmarks/", import.meta.url);
mkdirSync(outputDirectory, { recursive: true });
const output = new URL("layer-layout.json", outputDirectory);
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.table(results.map(({ shape, nodes, targetDepth, focusLayers, allLayers, allOmitted, medianMs, p95Ms, focusWithin16ms }) => ({
    shape,
    nodes,
    targetDepth,
    focusLayers,
    allLayers,
    allOmitted,
    medianMs: medianMs.toFixed(3),
    p95Ms: p95Ms.toFixed(3),
    focusWithin16ms,
  })));
  console.log(`Report: ${fileURLToPath(output)}`);
}
