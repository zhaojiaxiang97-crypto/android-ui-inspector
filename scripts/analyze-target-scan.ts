// Usage: bun scripts/analyze-target-scan.ts <readonly-probe.json> [...]
// Only bounded numeric fields leave the analyzer; original UI content never prints.
import { readFileSync } from "node:fs";
import { assessTargetScanProbe } from "../shared/target-scan-feasibility";

if (process.argv.length < 3) throw new Error("请传入至少一份 Helper 只读预检 JSON；不会连接设备或发送输入。");
if (process.argv.length > 103) throw new Error("一次最多分析 100 份预检。");
const samples = process.argv.slice(2).map(path => assessTargetScanProbe(JSON.parse(readFileSync(path, "utf8"))));
console.log(JSON.stringify({ version: 1, source: "read-only-probe", sampleCount: samples.length,
  warning: "预测基于单窗口、静态树和已完成子读取均值；不能证明 1 秒期限不可实现，也不允许降低唯一性或派发约束。",
  samples }, null, 2));
