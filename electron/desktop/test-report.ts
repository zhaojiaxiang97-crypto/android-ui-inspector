import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { legacyTestReportIndexSchema, type LoadedTestReport, type TestReportIndex } from "../../shared/test-report";
import { DEBUG_REPORT_VERSION, LEGACY_DEBUG_REPORT_VERSION } from "../../shared/debug-report";
import { loadDebugReport, type DebugReportLoadOptions } from "./debug-report";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const inside = (root: string, file: string) => { const path = relative(root, file); return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path); };
async function readBounded(file: string, limit: number) {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error("报告或图片过大，不能导入。");
    const bytes = Buffer.alloc(info.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count !== info.size) throw new Error("文件读取期间发生变化，请重新整理报告。");
    return bytes.subarray(0, count);
  } finally { await handle.close(); }
}

// 对照原始报告的展示字段；不因索引改了状态或步骤就宣称测试通过。
function verifySource(index: TestReportIndex, document: any) {
  const run = document?.run;
  if (document?.schemaVersion !== "report-1" || !run || !Array.isArray(run.serialGroups) || run.serialGroups.length || run.explore || run.carried) {
    throw new Error("原始报告类型不支持。");
  }
  const error = (e: any) => e ? { category: e.category, code: e.code, message: e.message, phase: e.phase, source: e.source, details: e.details } : null;
  const clean = (value: unknown) => JSON.parse(JSON.stringify(value));
  const expectedRun = { id: run.id, status: run.status, exitCode: run.exitCode, startedAt: run.startedAt, finishedAt: run.finishedAt,
    runner: run.runner, modelTokens: run.usage?.modelTokens ?? null, errors: run.errors.map(error) };
  const expected = run.results.map((result: any) => ({ id: result.id, title: result.titlePath.join(" / "), targetId: result.targetId,
    status: result.status, selected: result.selected, source: result.source ?? null, attempts: result.attempts.map((a: any) => ({
      id: a.id, index: a.index, status: a.status, durationMs: a.durationMs, cleanup: a.cleanup ?? "unknown", error: error(a.error),
      secondaryErrors: a.secondaryErrors.map(error), failure: a.failure ? { screenshot: a.failure.screenshot, screen: a.failure.screen, candidates: a.failure.candidates } : null,
      steps: a.steps.map((s: any) => ({ id: s.id, api: s.api, label: s.label, status: s.status, durationMs: s.durationMs, source: s.source ?? null, error: error(s.error) })),
      artifacts: a.artifacts.map((image: any) => ({ id: image.id, kind: image.kind, stepId: image.producer?.stepId ?? null, failureEvidence: image.id === a.failure?.screenshot })),
    })) }));
  const actual = index.cases.map(c => ({ ...c, attempts: c.attempts.map(a => ({ ...a,
    artifacts: a.artifacts.map(image => ({ id: image.id, kind: image.kind, stepId: image.stepId, failureEvidence: image.failureEvidence })),
  })) }));
  if (!isDeepStrictEqual(clean(index.run), clean(expectedRun)) || !isDeepStrictEqual(clean(actual), clean(expected))) {
    throw new Error("索引与原始报告不一致，请重新生成索引。");
  }
}

export async function loadTestReport(file: string, options: DebugReportLoadOptions = {}): Promise<LoadedTestReport> {
  const actualFile = await realpath(file);
  const selectedReport = basename(file) === "report.json";
  const input = await readBounded(actualFile, (selectedReport ? 32 : 8) * 1024 * 1024);
  const document = JSON.parse(input.toString("utf8"));
  if (document?.schemaVersion === DEBUG_REPORT_VERSION || document?.schemaVersion === LEGACY_DEBUG_REPORT_VERSION) {
    if (!selectedReport || actualFile !== join(await realpath(dirname(resolve(file))), "report.json")) throw new Error("请直接选择原始调试 report.json，不能选择链接或派生索引。");
    return loadDebugReport(dirname(actualFile), input, document, options);
  }
  if (input.length > 8 * 1024 * 1024) throw new Error("旧报告索引过大，不能导入。");
  const index = legacyTestReportIndexSchema.parse(document);
  const reportDirectory = dirname(dirname(actualFile));
  const sourceFile = join(reportDirectory, "report.json");
  if (await realpath(sourceFile) !== sourceFile) throw new Error("原始报告不能是目录外链接。");
  const bytes = await readBounded(sourceFile, 8 * 1024 * 1024);
  if (sha(bytes) !== index.reportSha256) throw new Error("原始报告已变化，请重新整理后导入。");
  const original = JSON.parse(bytes.toString("utf8"));
  verifySource(index, original);
  const attemptIds = index.cases.flatMap(c => c.attempts.map(a => a.id));
  const caseIds = index.cases.map(c => c.id);
  const stepCount = index.cases.reduce((sum, c) => sum + c.attempts.reduce((n, a) => n + a.steps.length, 0), 0);
  if (new Set(caseIds).size !== caseIds.length || new Set(attemptIds).size !== attemptIds.length || stepCount > 5000) throw new Error("报告编号重复或步骤过多。");
  const images: LoadedTestReport["images"] = [];
  let totalBytes = 0;
  for (const [caseIndex, entry] of index.cases.entries()) for (const [attemptIndex, attempt] of entry.attempts.entries()) {
    if (new Set(attempt.steps.map(s => s.id)).size !== attempt.steps.length || new Set(attempt.artifacts.map(a => a.id)).size !== attempt.artifacts.length) throw new Error("报告步骤或附件编号重复。");
    for (const [artifactIndex, artifact] of attempt.artifacts.entries()) {
      if (artifact.kind !== "screenshot") continue;
      const image: LoadedTestReport["images"][number] = { attemptId: attempt.id, artifactId: artifact.id, dataUrl: null, error: null };
      try {
        if (images.length >= 100) throw new Error("截图过多，未加载此图片。");
        const raw = original.run.results[caseIndex].attempts[attemptIndex].artifacts[artifactIndex];
        const path = raw.path;
        if (raw.mediaType !== "image/png" || typeof path !== "string" || !path.endsWith(".png") || isAbsolute(path) || path.includes("\\") || path.split("/").some(p => p === ".." || p === ".")) throw new Error("截图路径不安全。");
        const root = join(reportDirectory, "artifacts"), target = resolve(root, path);
        if (await realpath(root) !== root || !inside(root, await realpath(target))) throw new Error("截图越过报告目录。");
        if (!artifact.sha256 || (raw.sha256 && artifact.sha256 !== raw.sha256)) throw new Error("截图缺少一致的完整性摘要。");
        const data = await readBounded(target, 10 * 1024 * 1024);
        if (data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || sha(data) !== artifact.sha256 || (raw.size !== undefined && data.length !== raw.size)) throw new Error("截图已变化或不是PNG，未加载。");
        if (totalBytes + data.length > 16 * 1024 * 1024) throw new Error("截图总量超过16MB，未加载此图片。");
        totalBytes += data.length;
        image.dataUrl = `data:image/png;base64,${data.toString("base64")}`;
      } catch (error) { image.error = error instanceof Error && !error.message.includes("ENOENT") ? error.message : "截图文件缺失或不可读取。"; }
      images.push(image);
    }
  }
  return { index, images };
}
