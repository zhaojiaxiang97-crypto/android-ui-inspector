import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeNode } from "../../benchmarks/fixtures";
import { loadTestReport } from "../../electron/desktop/test-report";
import { DEBUG_REPORT_VERSION, DEBUG_SNAPSHOT_VERSION, type DebugSessionReport, type DebugSnapshotDocument } from "../../shared/debug-report";
import type { DebugTaskCheckResult, DebugTaskDefinition, DebugTaskObservation } from "../../shared/debug-task";

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
export function comparisonDefinition(packageName = "com.example.comparison"): DebugTaskDefinition {
  return { goal: "打开设置并确认保存结果", checkpoints: [
    { id: "settings", title: "打开设置", conditions: [{ id: "settings-visible", selector: { text: "设置", className: "android.widget.TextView" }, state: "visible" }] },
    { id: "ready", title: "允许保存", conditions: [{ id: "save-enabled", selector: { resourceId: `${packageName}:id/save` }, state: "enabled" }] },
  ], finalConditions: [{ id: "saved-visible", selector: { text: "已保存", resourceId: `${packageName}:id/save` }, state: "visible" },
    { id: "error-absent", selector: { resourceId: `${packageName}:id/error` }, state: "absent" }] };
}
export function makeDebugTaskComparisonFixture(options: { base?: string; seed?: number; serial?: string; packageName?: string;
  definition?: DebugTaskDefinition; scale?: number; offsetMs?: number } = {}) {
  const directory = realpathSync(mkdtempSync(join(options.base ?? tmpdir(), "inspector-task-comparison-"))); mkdirSync(join(directory, "artifacts"));
  const file = join(directory, "report.json"), seed = options.seed ?? 1, serial = options.serial ?? "offline-comparison-device";
  const packageName = options.packageName ?? "com.example.comparison", taskId = uuid(seed + 1), sessionId = uuid(seed), scale = options.scale ?? 1;
  const at = (milliseconds: number) => new Date(Date.UTC(2026, 9, 12, 9) + (options.offsetMs ?? 0) + milliseconds * scale).toISOString();
  const definition = options.definition ?? comparisonDefinition(packageName), missing = { snapshotId: null, freshness: "missing" as const, reason: "此步骤没有观察" };
  const report: DebugSessionReport = { schemaVersion: DEBUG_REPORT_VERSION, session: { id: sessionId, serial, packageName,
    startedAt: at(0), updatedAt: at(20), active: false, stopReason: "离线记录结束", totalSteps: 1, droppedSteps: 0 },
    limits: { maxSteps: 100, maxSnapshots: 200, maxImages: 100, maxBytes: 32 * 1024 * 1024, maxTreeBytes: 2 * 1024 * 1024, maxImageBytes: 10 * 1024 * 1024 },
    storage: { bytes: 0 }, snapshots: [], steps: [{ step: { id: 1, time: at(0), action: "define_debug_task", input: { sessionId, definition: structuredClone(definition) },
      status: "done", message: "固定任务已定义", verified: null }, finishedAt: at(10), durationMs: 10 * scale, verified: null, before: missing, after: missing }],
    task: { id: taskId, definedStepId: 1, definedAt: at(0), definition: structuredClone(definition), checks: [] } };
  let sequence = seed + 100;
  const save = () => {
    const bytes = report.snapshots.reduce((sum, snapshot) => sum + (snapshot.tree?.size ?? 0), 0);
    for (let attempt = 0; attempt < 8; attempt++) {
      const text = JSON.stringify(report), total = Buffer.byteLength(text) + bytes;
      if (total === report.storage.bytes) { writeFileSync(file, text); return; } report.storage.bytes = total;
    }
    throw Error("Comparison fixture size did not converge");
  };
  const observation = (milliseconds: number, bad = false): DebugTaskObservation => {
    const snapshotId = uuid(sequence++), root = makeNode("0"), setting = makeNode("0/0", 1), saved = makeNode("0/1", 2);
    root.package = setting.package = saved.package = packageName; root.text = null; root.resourceId = root.contentDesc = null;
    root.bounds = { left: 0, top: 0, right: 360, bottom: 640, raw: "[0,0][360,640]" };
    setting.text = "设置"; setting.resourceId = `${packageName}:id/settings`; setting.contentDesc = null;
    setting.bounds = { left: 10, top: 20, right: 160, bottom: 60, raw: "[10,20][160,60]" };
    saved.text = bad ? "未保存" : "已保存"; saved.resourceId = `${packageName}:id/save`; saved.contentDesc = null;
    saved.bounds = { left: 10, top: 80, right: 160, bottom: 120, raw: "[10,80][160,120]" }; root.children = [setting, saved];
    if (bad) { const error = makeNode("0/2", 3); error.package = packageName; error.text = "保存失败"; error.resourceId = `${packageName}:id/error`; root.children.push(error); }
    const frame = { width: 360, height: 640, rotation: 0 as const };
    const document: DebugSnapshotDocument = { schemaVersion: DEBUG_SNAPSHOT_VERSION, snapshotId, capturedAt: at(milliseconds),
      content: "tree-properties-without-layer-bitmaps", snapshot: { serial, root, nodeCount: root.children.length + 1, xmlSize: 0, rawXml: null, screenshotDataUrl: null,
        error: null, warning: null, inspectionSource: "uiautomator", captureMode: "fast", hierarchyDumpMode: "full",
        captureGeometry: { screenshotSize: frame, beforeScreenshot: frame, afterScreenshot: frame, hierarchyRotation: 0 } } };
    const bytes = Buffer.from(JSON.stringify(document)), sha256 = createHash("sha256").update(bytes).digest("hex"), path = `artifacts/${sha256}.json`;
    writeFileSync(join(directory, path), bytes); report.snapshots.push({ snapshotId, capturedAt: document.capturedAt, source: "uiautomator", screenshot: null,
      tree: { path, sha256, size: bytes.length }, warnings: [] });
    return { snapshotId, capturedAt: document.capturedAt, component: `${packageName}/.Settings`, windowId: "fixture-window", activityRecordId: "fixture-activity" };
  };
  function addCheck(checkpointId: string | null = null, bad = false) {
    const stepId = report.session.totalSteps + 1, start = stepId * 1000, first = observation(start + 100, bad), second = observation(start + 500, bad);
    const conditions = checkpointId === null ? definition.finalConditions : definition.checkpoints.find(stage => stage.id === checkpointId)!.conditions;
    const check: DebugTaskCheckResult = { taskId, stepId, checkpointId, checkedAt: at(start + 600), status: "passed", reason: "原始记录声明通过",
      observations: { first, second }, conditions: conditions.map(condition => ({ conditionId: condition.id, status: "passed", reason: "原始条件记录",
        firstMatchCount: 1, secondMatchCount: 1, firstNodeId: "0/1", secondNodeId: "0/1" })) };
    const ref = (observed: DebugTaskObservation) => ({ snapshotId: observed.snapshotId, freshness: "current" as const, reason: null });
    report.steps.push({ step: { id: stepId, time: at(start), action: "check_debug_task", input: { sessionId, taskId, ...(checkpointId === null ? {} : { checkpointId }) },
      status: "done", message: "原始验收记录", taskCheck: structuredClone(check), verified: true, beforeId: first.snapshotId, afterId: second.snapshotId },
      finishedAt: at(start + 700), durationMs: 700 * scale, verified: true, before: ref(first), after: ref(second) });
    report.task!.checks = report.task!.checks.filter(value => value.checkpointId !== checkpointId).concat(check);
    report.task!.checks.sort((a, b) => (a.checkpointId === null ? 99 : definition.checkpoints.findIndex(stage => stage.id === a.checkpointId))
      - (b.checkpointId === null ? 99 : definition.checkpoints.findIndex(stage => stage.id === b.checkpointId)));
    report.session.totalSteps = stepId; report.session.updatedAt = at(start + 800); save(); return check;
  }
  function complete(badFinal = false) { for (const checkpoint of definition.checkpoints) addCheck(checkpoint.id); return addCheck(null, badFinal); }
  save(); return { directory, file, report, save, addCheck, complete, load: () => loadTestReport(file), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
