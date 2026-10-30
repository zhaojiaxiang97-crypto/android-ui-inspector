// Offline comparison of two authorized, local snapshots; prints only aggregated counts.
// Usage: bun scripts/compare-capture-sources.ts uiautomator.json helper.json
import { readFileSync } from "node:fs";
import { compareCaptureSources } from "../shared/capture-source-comparison";
import { isUiSnapshot } from "../shared/snapshot-validation";

if (process.argv.length !== 4) throw new Error("用法：bun scripts/compare-capture-sources.ts LEFT.json RIGHT.json");
function load(path: string) {
  const contents = JSON.parse(readFileSync(path, "utf8"));
  const snapshot = contents?.snapshot ?? contents;
  if (!isUiSnapshot(snapshot)) throw new Error("文件不包含有效的完整UI快照。");
  return snapshot;
}
console.log(JSON.stringify(compareCaptureSources(load(process.argv[2]), load(process.argv[3])), null, 2));
