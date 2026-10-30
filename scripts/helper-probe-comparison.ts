import { readFile } from "node:fs/promises";
import { z } from "zod";
import { helperTargetProbeReply } from "../shared/helper-target-probe";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sample = z.object({
  capturedAt: z.iso.datetime(), serial: z.string().min(1), nodeCount: z.number().int().positive(),
  observationMs: z.number().finite().nonnegative(), probeWallMs: z.number().finite().positive(),
  helperDeadlineMs: z.literal(1000), reply: helperTargetProbeReply,
}).strict();
const block = z.object({ apkSha256: digest, samples: z.array(sample).min(3).max(20) }).strict();
const manifest = z.object({
  version: z.literal(1), serial: z.string().min(1), packageName: z.string().min(1),
  fixtureSha256: digest, sampleApkSha256: digest,
  blocks: z.tuple([block, block, block]),
}).strict();

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Offline only: no device access, installation, authorization or input. */
export function compareHelperProbes(input: unknown) {
  const data = manifest.parse(input), [before, candidate, after] = data.blocks;
  if (before.apkSha256 !== after.apkSha256 || before.apkSha256 === candidate.apkSha256)
    throw new Error("必须按同一原版 A → 候选 B → 同一原版 A 提供 APK 摘要。");
  if (data.blocks.some(b => b.samples.length !== before.samples.length))
    throw new Error("三组样本数量必须一致，不能挑选成功轮次。");
  const first = before.samples[0], requests = new Set<string>(), captures = new Set<string>();
  let previousTime = -Infinity;
  for (const b of data.blocks) for (const s of b.samples) {
    const r = s.reply, time = Date.parse(s.capturedAt);
    if (s.serial !== data.serial || r.packageName !== data.packageName
      || JSON.stringify(r.display) !== JSON.stringify(first.reply.display) || s.nodeCount !== first.nodeCount)
      throw new Error("设备、App、屏幕或节点规模不同，不能作为同条件对照。");
    if (r.status !== "completed" && r.status !== "timeout")
      throw new Error("拒绝或认证失败不是性能样本，须单独调查并重做整组。");
    if (r.finishedAtMs <= r.startedAtMs) throw new Error("预检耗时必须为正数。");
    if (time <= previousTime || requests.has(r.requestId) || captures.has(r.captureId))
      throw new Error("样本顺序错误或复用了旧请求/快照。");
    previousTime = time; requests.add(r.requestId); captures.add(r.captureId);
  }
  const groups = data.blocks.map((b, index) => ({
    group: ["A-before", "B", "A-after"][index], count: b.samples.length,
    completed: b.samples.filter(s => s.reply.status === "completed").length,
    timeout: b.samples.filter(s => s.reply.status === "timeout").length,
    observationMedianMs: median(b.samples.map(s => s.observationMs)),
    probeWallMedianMs: median(b.samples.map(s => s.probeWallMs)),
    completedPreflightMedianMs: b.samples.every(s => s.reply.status === "completed")
      ? median(b.samples.map(s => s.reply.finishedAtMs - s.reply.startedAtMs)) : null,
  }));
  const baselineMs = (groups[0].probeWallMedianMs + groups[2].probeWallMedianMs) / 2;
  const allCompleted = groups.every(g => g.completed === g.count);
  return {
    version: 1, sameConditionsDeclared: true, groups,
    baselineDriftPercent: 100 * (groups[2].probeWallMedianMs / groups[0].probeWallMedianMs - 1),
    candidateWallDifferencePercent: 100 * (groups[1].probeWallMedianMs / baselineMs - 1),
    completedPreflightDifferencePercent: allCompleted
      ? 100 * (groups[1].completedPreflightMedianMs!
        / ((groups[0].completedPreflightMedianMs! + groups[2].completedPreflightMedianMs!) / 2) - 1) : null,
    conclusion: allCompleted
      ? "仅报告同条件声明下的差值；须结合原版漂移判断，不自动认定提速。"
      : "存在截止样本，实际完成耗时未知；墙钟差不能当作扫描提速。",
  };
}

if (import.meta.main) {
  try {
    const path = process.argv[2];
    if (!path || process.argv.length !== 3) throw new Error("用法：bun scripts/helper-probe-comparison.ts <A-B-A清单.json>");
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("清单超过 1 MiB。");
    console.log(JSON.stringify(compareHelperProbes(JSON.parse(raw)), null, 2));
  } catch {
    console.error("对照清单无效；请检查顺序、身份、独立快照、完整轮次及只读回执。不会访问设备或补跑动作。");
    process.exitCode = 1;
  }
}
