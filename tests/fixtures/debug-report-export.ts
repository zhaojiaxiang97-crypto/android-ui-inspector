import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { makeNode } from "../../benchmarks/fixtures";
import { DEBUG_REPORT_VERSION, DEBUG_SNAPSHOT_VERSION, type DebugSessionReport, type DebugSnapshotDocument } from "../../shared/debug-report";

export const exportDigest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export async function makeDebugReportExportFixture(base = tmpdir()) {
  const root = realpathSync(mkdtempSync(join(base, "inspector-export-")));
  const directory = join(root, "source"), parent = join(root, "destination"), file = join(directory, "report.json");
  mkdirSync(join(directory, "artifacts"), { recursive: true }); mkdirSync(parent);
  const sessionId = uuid(1), packageName = "com.example.export", serial = "offline-export-fixture";
  const report: DebugSessionReport = { schemaVersion: DEBUG_REPORT_VERSION,
    session: { id: sessionId, serial, packageName, startedAt: "2026-10-12T09:00:00.000Z", updatedAt: "2026-10-12T09:00:03.000Z",
      active: false, stopReason: "离线测试已结束", totalSteps: 3, droppedSteps: 0, androidLogsEnabled: false },
    limits: { maxSteps: 100, maxSnapshots: 200, maxImages: 100, maxBytes: 32 * 1024 * 1024, maxTreeBytes: 2 * 1024 * 1024, maxImageBytes: 10 * 1024 * 1024 },
    storage: { bytes: 0 }, steps: [], snapshots: [], task: null };
  const artifact = (bytes: Buffer, extension: string) => {
    const sha256 = exportDigest(bytes), path = `artifacts/${sha256}.${extension}`;
    writeFileSync(join(directory, path), bytes); return { path, sha256, size: bytes.length };
  };
  for (let id = 1; id <= 3; id++) {
    const time = `2026-10-12T09:00:0${id - 1}.000Z`, finishedAt = `2026-10-12T09:00:0${id}.000Z`, snapshotId = uuid(id + 1);
    const node = makeNode("0"); node.package = packageName; node.text = `离线页面${id}`;
    const tree: DebugSnapshotDocument = { schemaVersion: DEBUG_SNAPSHOT_VERSION, snapshotId, capturedAt: time,
      content: "tree-properties-without-layer-bitmaps", snapshot: { serial, root: node, nodeCount: 1, xmlSize: 0,
        rawXml: null, screenshotDataUrl: null, error: null, warning: null, inspectionSource: "uiautomator", captureMode: "fast" } };
    const image = await sharp({ create: { width: 4, height: 6, channels: 4, background: ["#245588", "#774422", "#558833"][id - 1] } }).png().toBuffer();
    report.snapshots.push({ snapshotId, capturedAt: time, source: "uiautomator", tree: artifact(Buffer.from(JSON.stringify(tree)), "json"),
      screenshot: artifact(image, "png"), warnings: [] });
    report.steps.push({ step: { id, time, action: id === 2 ? "wait_for_ui" : "capture_ui",
      input: id === 2 ? { sessionId, selector: { text: "未出现" }, state: "visible", timeoutMs: 1000 } : { sessionId, mode: "fast", backend: "uiautomator" },
      status: id === 2 ? "failed" : "done", message: id === 2 ? "等待失败" : `页面${id}已采集`, afterId: snapshotId,
      ...(id === 2 ? { error: { category: "timeout", code: "timeout", phase: "verify" as const, message: "页面条件超时" } } : {}) },
      finishedAt, durationMs: 1000, verified: id === 2 ? false : null,
      before: { snapshotId: null, freshness: "missing", reason: "没有保留前观察" }, after: { snapshotId, freshness: "current", reason: null } });
    if (id === 2) {
      const text = `[${finishedAt}] ERROR timeout/verify/timeout token=fixture-private excluded-step-log\n`;
      report.steps.at(-1)!.logs = [{ source: "session", sessionId, stepId: id, packageName, startedAt: time, finishedAt,
        status: "available", attribution: "confirmed", reason: null, truncated: false, lineCount: 1, file: artifact(Buffer.from(text), "txt"), androidScope: null }];
    }
  }
  const save = () => {
    const files = new Map(report.snapshots.flatMap(snapshot => [snapshot.tree, snapshot.screenshot]).filter(Boolean).map(file => [file!.path, file!.size]));
    for (const entry of report.steps) for (const log of entry.logs ?? []) if (log.file) files.set(log.file.path, log.file.size);
    for (let i = 0; i < 8; i++) {
      const bytes = JSON.stringify(report), total = Buffer.byteLength(bytes) + [...files.values()].reduce((sum, size) => sum + size, 0);
      if (total === report.storage.bytes) { writeFileSync(file, bytes); return; }
      report.storage.bytes = total;
    }
    throw Error("fixture storage count did not converge");
  };
  save();
  const request = () => ({ requestId: "request-1", sourceId: "source-1", reportSha256: exportDigest(readFileSync(file)), stepIds: "all" as const,
    includeTrees: true, includeScreenshots: true, includeLogs: true });
  const source = () => ({ filePath: file, reportSha256: request().reportSha256 });
  return { root, directory, parent, file, report, artifact, save, request, source, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
