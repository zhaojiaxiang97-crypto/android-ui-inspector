import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, release } from "node:os";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createTree, type TreeShape } from "../benchmarks/fixtures";
import { statistics } from "../benchmarks/statistics";
import { filterTree, flattenNodes, type TreeFilter } from "../shared/tree-utils";
import type { UiNode } from "../shared/types";

const iterations = 15;
const warmups = 3;
const sizes = [1_000, 5_000, 10_000, 25_000];
const shapes: TreeShape[] = ["balanced", "wide"];
const filters: Record<string, TreeFilter> = {
  "filter-all": { query: "android.", interactiveOnly: false, identifiedOnly: false },
  "filter-sparse": { query: "synthetic-target", interactiveOnly: false, identifiedOnly: false },
  "filter-none": { query: "does-not-exist", interactiveOnly: false, identifiedOnly: false },
  "filter-interactive": { query: "", interactiveOnly: true, identifiedOnly: false },
};

function measure(operation: () => unknown) {
  for (let index = 0; index < warmups; index += 1) operation();
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    operation();
    samples.push(performance.now() - start);
  }
  return statistics(samples);
}

const results = shapes.flatMap((shape) => sizes.flatMap((size) => {
  const root = createTree(size, shape);
  assert.equal(flattenNodes(root).size, size);
  const rows = [{ shape, nodes: size, operation: "flatten", retainedNodes: size, ...measure(() => flattenNodes(root)) }];
  for (const [operation, filter] of Object.entries(filters)) {
    let filtered: UiNode | null = null;
    const timings = measure(() => { filtered = filterTree(root, filter); });
    // Counting is deliberately outside the timed filter operation.
    const retainedNodes = filtered ? flattenNodes(filtered).size : 0;
    if (operation === "filter-all") assert.equal(retainedNodes, size);
    if (operation === "filter-none") assert.equal(retainedNodes, 0);
    if (operation === "filter-sparse") assert.ok(retainedNodes > 1 && retainedNodes < size);
    rows.push({ shape, nodes: size, operation, retainedNodes, ...timings });
  }
  return rows;
}));

const report = {
  generatedAt: new Date().toISOString(),
  environment: { runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`, platform: process.platform, os: release(), arch: process.arch, cpu: cpus()[0]?.model },
  scope: "Pure tree processing only; excludes React rendering, DOM, ADB and screenshot capture",
  iterations,
  warmups,
  results,
};
const outputDirectory = new URL("../.benchmarks/", import.meta.url);
mkdirSync(outputDirectory, { recursive: true });
const output = new URL("tree-logic.json", outputDirectory);
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.table(results.map(({ shape, nodes, operation, retainedNodes, medianMs, p95Ms }) => ({
    shape, nodes, operation, retainedNodes, medianMs: medianMs.toFixed(3), p95Ms: p95Ms.toFixed(3),
  })));
  console.log(`Report: ${fileURLToPath(output)}`);
}
