import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DEBUG_REPORT_EXPORT_VERSION, debugReportExportRequestSchema, type DebugReportExportRequest, type DebugReportExportResult } from "../../shared/debug-report-export";
import type { DebugReportFile, DebugSessionReport } from "../../shared/debug-report";
import type { LoadedTestReport } from "../../shared/test-report";
import { boundedDebugLogText, debugLogConfigurationSecrets, sanitizeDebugLogText } from "../automation/debug-logs";
import { loadTestReport } from "./test-report";

const MAX_BYTES = 32 * 1024 * 1024;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const check = (signal?: AbortSignal) => signal?.throwIfAborted();
type Omission = { stepId: number | null; snapshotId: string | null; kind: "tree" | "screenshot" | "logs" | "task"; reason: string };

async function readVerified(file: string, sha256: string, size: number | undefined, signal?: AbortSignal) {
  check(signal);
  const pathInfo = await lstat(file);
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || await realpath(file) !== file)
    throw new Error("证据源文件不能是链接、目录或特殊文件。");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!sameFile(info, pathInfo) || !info.isFile() || info.size > MAX_BYTES || size !== undefined && info.size !== size)
      throw new Error("证据源文件大小或身份已改变，请重新读取报告。");
    const bytes = Buffer.alloc(info.size + 1);
    let count = 0;
    while (count < bytes.length) {
      check(signal);
      const next = await handle.read(bytes, count, bytes.length - count, count);
      if (!next.bytesRead) break;
      count += next.bytesRead;
    }
    const after = await lstat(file);
    if (count !== info.size || !sameFile(info, await handle.stat()) || !sameFile(info, after)
      || after.isSymbolicLink() || await realpath(file) !== file || digest(bytes.subarray(0, count)) !== sha256)
      throw new Error("证据源文件读取期间改变或摘要不一致，请重新读取报告。");
    check(signal);
    return { bytes: bytes.subarray(0, count), info };
  } finally { await handle.close(); }
}

async function directoryUnchanged(path: string, identity: Stats) {
  const now = await lstat(path);
  if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== identity.dev || now.ino !== identity.ino || await realpath(path) !== path)
    throw new Error("导出目录在准备期间改变，已停止导出。");
}
async function removeOwned(path: string | null, identity: Stats | null) {
  if (!path || !identity) return;
  try {
    const now = await lstat(path);
    if (now.isDirectory() && !now.isSymbolicLink() && now.dev === identity.dev && now.ino === identity.ino)
      await rm(path, { recursive: true, force: true });
  } catch (error) { if (!isMissing(error)) throw error; }
}

function reportBytes(document: DebugSessionReport, files: Map<string, Buffer>) {
  const fileBytes = [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0);
  for (let i = 0; i < 8; i++) {
    const bytes = Buffer.from(JSON.stringify(document, null, 2));
    const total = bytes.length + fileBytes;
    if (total > document.limits.maxBytes || total > MAX_BYTES) throw new Error("所选证据超过32MiB上限，请减少步骤或附件后导出。");
    if (total === document.storage.bytes) return bytes;
    document.storage.bytes = total;
  }
  throw new Error("证据包大小无法稳定计算，未导出。");
}

function downgradeChecks(document: DebugSessionReport, loaded: LoadedTestReport, omissions: Omission[]) {
  const effective = new Map(loaded.debug?.taskAssessment?.checks.map(value => [value.recorded.stepId, value.effective]) ?? []);
  const changed = new Set<number>();
  for (const entry of document.steps) {
    const result = entry.step.taskCheck, assessment = effective.get(entry.step.id);
    if (!result || !assessment || assessment.status === "passed" || result.status === assessment.status && result.reason === assessment.reason) continue;
    Object.assign(result, { status: assessment.status, reason: assessment.reason, conditions: structuredClone(assessment.conditions) });
    entry.verified = entry.step.verified = false;
    entry.step.message = `导出副本验收未确认：${assessment.reason}`.slice(0, 16000);
    changed.add(entry.step.id);
    omissions.push({ stepId: entry.step.id, snapshotId: null, kind: "task", reason: assessment.reason });
  }
  for (const result of document.task?.checks ?? []) {
    const entry = document.steps.find(item => item.step.id === result.stepId);
    if (changed.has(result.stepId) && entry?.step.taskCheck) Object.assign(result, structuredClone(entry.step.taskCheck));
  }
  return changed.size > 0;
}

const hasInvalidIncludedArtifact = (report: LoadedTestReport) => Boolean(report.debug?.snapshots.some(value => value.evidence.tree && value.treeError)
  || report.images.some(value => value.error) || report.debug?.steps.some(entry => entry.logs?.some(log => log.file && log.loadError)));

/** Source paths are supplied only by main's owner-bound import registry, never by renderer input. */
export async function exportDebugReportEvidence(source: { filePath: string; reportSha256: string }, raw: DebugReportExportRequest,
  parentDirectory: string, options: { appVersion: string; signal?: AbortSignal }): Promise<DebugReportExportResult> {
  let staging: string | null = null, stagingIdentity: Stats | null = null;
  let destination: string | null = null, destinationIdentity: Stats | null = null;
  const signal = options.signal;
  try {
    check(signal);
    const request = debugReportExportRequestSchema.parse(raw);
    if (request.reportSha256 !== source.reportSha256 || !/^[a-f0-9]{64}$/.test(source.reportSha256))
      throw new Error("导出来源与已加载报告不一致，请重新读取报告。");
    if (!options.appVersion || options.appVersion.length > 128 || /[\x00-\x1f]/.test(options.appVersion)) throw new Error("桌面版本信息无效。");
    const file = resolve(source.filePath);
    if (basename(file) !== "report.json") throw new Error("只能导出已加载的原始调试 report.json。");
    const original = await readVerified(file, source.reportSha256, undefined, signal);
    const loaded = await loadTestReport(file);
    if (!loaded.debug || loaded.index.reportSha256 !== source.reportSha256) throw new Error("原始调试报告已改变，请重新读取后导出。");
    check(signal);
    const document = JSON.parse(original.bytes.toString("utf8")) as DebugSessionReport;
    const selected = request.stepIds === "all" ? document.steps.map(entry => entry.step.id) : request.stepIds;
    if (selected.some(id => !document.steps.some(entry => entry.step.id === id))) throw new Error("所选步骤未保留在这份报告中，请重新选择。");
    const selectedIds = new Set(selected);
    document.steps = document.steps.filter(entry => selectedIds.has(entry.step.id));
    document.session.droppedSteps = document.session.totalSteps - document.steps.length;
    // Sparse selection is a historical subset; a progress record for an excluded step cannot describe it.
    if (document.session.progress?.stepId !== document.steps.at(-1)?.step.id) delete document.session.progress;
    if (document.task) {
      if (!selectedIds.has(document.task.definedStepId) && document.task.definedStepId > document.session.droppedSteps)
        throw new Error(`所选步骤需要任务定义步骤 #${document.task.definedStepId}，请一并选择该步骤或导出全部步骤。`);
      document.task.checks = document.task.checks.filter(result => selectedIds.has(result.stepId));
    }
    const snapshotIds = new Set(document.steps.flatMap(entry => [entry.before.snapshotId, entry.after.snapshotId]).filter(Boolean));
    document.snapshots = document.snapshots.filter(snapshot => snapshotIds.has(snapshot.snapshotId));
    const omissions: Omission[] = [], files = new Map<string, Buffer>();
    const originals = new Map<string, { file: DebugReportFile; info: Stats }>();
    const root = dirname(file), artifactRoot = join(root, "artifacts");
    const snapshotById = new Map(loaded.debug.snapshots.map(snapshot => [snapshot.evidence.snapshotId, snapshot]));
    const imageById = new Map(loaded.images.map(image => [image.artifactId, image]));
    const keep = (bytes: Buffer, extension: string): DebugReportFile => {
      const sha256 = digest(bytes), path = `artifacts/${sha256}.${extension}`;
      files.set(path, bytes); return { path, sha256, size: bytes.length };
    };
    const readArtifact = async (artifact: DebugReportFile, unavailable: string | null) => {
      if (!/^artifacts\/[a-f0-9]{64}\.(json|png|txt)$/.test(artifact.path) || !artifact.path.startsWith(`artifacts/${artifact.sha256}.`))
        throw new Error("证据附件路径或摘要不安全，未导出。");
      try {
        const directory = await lstat(artifactRoot);
        if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(artifactRoot) !== artifactRoot)
          throw new Error("证据附件目录不能是链接或特殊文件。");
        const value = await readVerified(join(root, artifact.path), artifact.sha256, artifact.size, signal);
        if (unavailable) throw new Error(`证据附件未通过读取校验：${unavailable}`);
        originals.set(artifact.path, { file: artifact, info: value.info });
        return value.bytes;
      } catch (error) { if (isMissing(error)) return null; throw error; }
    };
    for (const snapshot of document.snapshots) {
      const verified = snapshotById.get(snapshot.snapshotId)!;
      for (const kind of ["tree", "screenshot"] as const) {
        const included = kind === "tree" ? request.includeTrees : request.includeScreenshots, artifact = snapshot[kind];
        let reason = !included ? `导出未包含${kind === "tree" ? "树与属性" : "截图"}证据。`
          : !artifact ? `原报告未保存此${kind === "tree" ? "树与属性" : "截图"}证据。` : null;
        if (!reason && artifact) {
          const unavailable = kind === "tree" ? verified.treeError
            : imageById.has(artifact.sha256) ? imageById.get(artifact.sha256)!.error : "截图未通过加载校验。";
          const bytes = await readArtifact(artifact, unavailable);
          if (bytes) snapshot[kind] = keep(bytes, kind === "tree" ? "json" : "png");
          else reason = `原报告的${kind === "tree" ? "树与属性" : "截图"}附件缺失，未包含内容。`;
        }
        if (reason) {
          snapshot[kind] = null; snapshot.warnings = [...snapshot.warnings.slice(-98), reason];
          omissions.push({ stepId: null, snapshotId: snapshot.snapshotId, kind, reason });
        }
      }
    }
    for (const entry of document.steps) {
      if (!entry.logs) omissions.push({ stepId: entry.step.id, snapshotId: null, kind: "logs",
        reason: request.includeLogs ? "原报告没有保存步骤日志。" : "导出未包含错误日志附件。" });
      for (const log of entry.logs ?? []) {
        const verified = loaded.debug.steps.find(value => value.step.id === entry.step.id)?.logs?.find(value => value.source === log.source);
        const artifact = log.file;
        let reason = !request.includeLogs ? "导出未包含错误日志附件。" : !artifact ? log.reason ?? "原报告没有保存此日志附件。" : null;
        if (!reason && artifact) {
          const bytes = await readArtifact(artifact, verified?.loadError ?? null);
          if (bytes) {
            const content = boundedDebugLogText(new TextDecoder("utf-8", { fatal: true }).decode(bytes), debugLogConfigurationSecrets());
            if (content.text) { log.file = keep(Buffer.from(content.text), "txt"); log.lineCount = content.lineCount; log.truncated ||= content.truncated; }
            else reason = "日志附件没有可保留的内容。";
          } else reason = "原报告的日志附件缺失，未包含内容。";
        }
        if (reason) {
          log.file = null; log.lineCount = 0;
          if (!request.includeLogs || artifact) { log.status = "unavailable"; log.reason = reason; }
          if (log.source === "android") { log.attribution = "missing"; log.androidScope = null; }
          omissions.push({ stepId: entry.step.id, snapshotId: null, kind: "logs", reason });
        }
        delete log.text; delete log.loadError;
      }
      if (entry.step.action === "wait_for_ui" && entry.verified === true
        && !document.snapshots.find(snapshot => snapshot.snapshotId === entry.after.snapshotId)?.tree) {
        entry.verified = entry.step.verified = false;
        entry.step.message = "导出副本缺少新观察的树证据，原页面断言不能作为此副本的通过依据。";
      }
    }
    const parent = await realpath(resolve(parentDirectory)), parentIdentity = await lstat(parent);
    if (!parentIdentity.isDirectory()) throw new Error("请选择可写入的目标文件夹。");
    staging = await mkdtemp(join(parent, ".debug-evidence-")); stagingIdentity = await lstat(staging);
    check(signal);
    await mkdir(join(staging, "artifacts"), { mode: 0o700 });
    for (const [path, bytes] of files) { check(signal); await writeFile(join(staging, path), bytes, { flag: "wx", mode: 0o600 }); }
    let bytes = reportBytes(document, files);
    await writeFile(join(staging, "report.json"), bytes, { flag: "wx", mode: 0o600 });
    let exported = await loadTestReport(join(staging, "report.json"));
    check(signal);
    if (hasInvalidIncludedArtifact(exported)) throw new Error("证据包未通过重新导入校验，未完成导出。");
    if (downgradeChecks(document, exported, omissions)) {
      bytes = reportBytes(document, files);
      await writeFile(join(staging, "report.json"), bytes, { mode: 0o600 });
      exported = await loadTestReport(join(staging, "report.json"));
      if (hasInvalidIncludedArtifact(exported)) throw new Error("证据包验收信息无法安全重新导入，未完成导出。");
    }
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: DEBUG_REPORT_EXPORT_VERSION, exportedAt: new Date().toISOString(),
      desktop: { name: "Android UI Inspector", version: options.appVersion },
      target: { deviceSerial: document.session.serial, packageName: document.session.packageName, appVersion: null,
        appVersionReason: "原报告没有保存目标App版本；导出没有采集手机。" },
      source: { schemaVersion: document.schemaVersion, reportSha256: source.reportSha256, sessionId: document.session.id },
      selection: { stepIds: document.steps.map(entry => entry.step.id), includeTrees: request.includeTrees,
        includeScreenshots: request.includeScreenshots, includeLogs: request.includeLogs },
      report: { path: "report.json", sha256: digest(bytes), size: bytes.length },
      files: [...files].map(([path, data]) => ({ path, sha256: digest(data), size: data.length })), omissions,
    }, null, 2));
    if (document.storage.bytes + manifest.length > MAX_BYTES) throw new Error("证据包连同清单超过32MiB，请减少步骤或附件。");
    await writeFile(join(staging, "manifest.json"), manifest, { flag: "wx", mode: 0o600 });
    const finalSource = await readVerified(file, source.reportSha256, original.bytes.length, signal);
    if (!sameFile(original.info, finalSource.info)) throw new Error("源报告在导出期间改变，请重新读取报告。");
    for (const [path, value] of originals) {
      const again = await readVerified(join(root, path), value.file.sha256, value.file.size, signal);
      if (!sameFile(value.info, again.info)) throw new Error("源附件在导出期间改变，请重新读取报告。");
    }
    check(signal); await directoryUnchanged(parent, parentIdentity); await directoryUnchanged(staging, stagingIdentity);
    // POSIX can replace our empty reservation; Windows rejects rename onto any existing directory.
    destination = join(parent, `Debug-evidence-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
    if (process.platform === "win32") {
      try { await lstat(destination); throw new Error("导出目标已存在，请重新导出到新的文件夹。"); }
      catch (error) { if (!isMissing(error)) throw error; }
    } else {
      await mkdir(destination, { mode: 0o700 }); destinationIdentity = await lstat(destination);
      await directoryUnchanged(destination, destinationIdentity);
    }
    check(signal);
    await rename(staging, destination); destinationIdentity = stagingIdentity; staging = null; stagingIdentity = null;
    check(signal);
    return { canceled: false, directory: destination, error: null, stepCount: document.steps.length,
      warnings: [...new Set(omissions.map(value => value.reason))].slice(0, 100) };
  } catch (error) {
    let cleanupError: string | null = null;
    try { await removeOwned(staging, stagingIdentity); await removeOwned(destination, destinationIdentity); }
    catch { cleanupError = "导出临时目录清理失败，请检查所选目标文件夹。"; }
    const canceled = signal?.aborted === true;
    return { canceled, directory: null, stepCount: 0, warnings: cleanupError ? [cleanupError] : [],
      error: canceled ? null : cleanupError ?? (error instanceof Error && error.name !== "ZodError"
        ? sanitizeDebugLogText(error.message, debugLogConfigurationSecrets()).slice(0, 16000) : "导出选项无效，未导出证据。") };
  }
}
