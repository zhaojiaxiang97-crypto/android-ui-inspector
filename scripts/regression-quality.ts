// Usage: bun scripts/regression-quality.ts CANDIDATE_ID PENDING_RUNS [summary.json ...]
// Summaries are accepted only when produced by the versioned regression runner.
import { readFileSync } from "node:fs";
import { summarizeRegressionQuality } from "../shared/regression-quality";

if (process.argv.length < 4 || !/^\d+$/.test(process.argv[3]))
  throw new Error("用法：bun scripts/regression-quality.ts CANDIDATE_ID PENDING_RUNS [summary.json ...]");
const output = summarizeRegressionQuality({ version: 1, candidateId: process.argv[2],
  pendingRuns: Number(process.argv[3]), runs: process.argv.slice(4).map(path => JSON.parse(readFileSync(path, "utf8"))) });
console.log(JSON.stringify(output, null, 2));
