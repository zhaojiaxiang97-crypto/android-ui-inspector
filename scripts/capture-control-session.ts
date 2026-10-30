import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { DebugSession } from "../electron/automation/debug-session";
import { loadTestReport } from "../electron/desktop/test-report";
import { assertSafeHelperObservationSnapshot } from "../shared/helper-observation";
import { debugTimingsSchema } from "../shared/debug-timing";
import type { DebugSessionReport } from "../shared/debug-report";
import { treatments, type ControlBlock, type ControlFrame, type ControlRole } from "./capture-control-protocol";

export type ControlTarget = { serial: string; packageName: string; helperPid: number; serviceId: string;
  width: number; height: number; rotation: 0; nodeCounts: { small: number; large: number }; selectors: { small: string; large: string } };
export type ControlBlockResult = { blockId: string; status: "running" | "passed" | "failed" | "cancelled";
  sessionId: string; reportPath: string | null; wallMs: number; frames: ControlFrame[];
  requests: { roles: readonly ControlRole[]; stepIds: number[]; attempts: number; complete: number; status: string; referenceManifest?: string; auditError?: string }[];
  failure?: string; failureCode?: string };
function reportFor(session: DebugSession): DebugSessionReport {
  assert(session.state.reportPath, "Missing product report");
  assert(statSync(session.state.reportPath).size <= 32 * 1024 * 1024, "Report exceeds original read budget");
  return JSON.parse(readFileSync(session.state.reportPath, "utf8"));
}

/** Same-process adapter only. No grants, page input, ADB, CLI, retries or automatic entry point. */
export async function executeControlBlock(session: DebugSession, block: ControlBlock, target: ControlTarget,
  signal: AbortSignal, checkpoint: (result: ControlBlockResult) => void, beforeRequest?: () => void): Promise<ControlBlockResult> {
  const started = performance.now();
  const result: ControlBlockResult = { blockId: block.id, status: "running", sessionId: session.state.id,
    reportPath: session.state.reportPath ?? null, wallMs: 0, frames: [], requests: [] };
  const publish = () => { result.reportPath = session.state.reportPath ?? null; result.wallMs = performance.now() - started; checkpoint(structuredClone(result)); };
  const check = () => {
    signal.throwIfAborted();
    if (Date.parse(session.state.expiresAt) - Date.now() < 17_000)
      throw Object.assign(new Error("Grant cannot cover operation and final recording"), { code: "grant_expired" });
    assert(session.state.active && !session.state.busy && !session.state.androidLogsEnabled, "Inactive/busy/logging session");
    assert.equal(session.state.serial, target.serial); assert.equal(session.state.packageName, target.packageName);
    assert(Date.parse(session.state.expiresAt) - Date.now() >= 17_000, "Grant cannot cover operation and final recording");
  };
  const id = target.selectors[block.page], roles = treatments[block.treatment];
  try {
    check(); publish();
    for (let position = 0; position < roles.length;) {
      check();
      const role = roles[position], paired = role !== "C0", group = roles.slice(position, position + (paired ? 2 : 1));
      const request: ControlBlockResult["requests"][number] = { roles: group, stepIds: [], attempts: 0, complete: 0, status: "running" };
      result.requests.push(request); publish();
      const before = session.state.steps.at(-1)?.id ?? 0;
      let ids: string[] = [];
      try {
        beforeRequest?.();
        if (role === "R1") {
          const reference = await session.captureReferencePair({ sessionId: session.state.id, runId: randomUUID(),
            selector: { resourceId: id }, expectedNodeCount: target.nodeCounts[block.page], timeoutMs: 15_000 }, signal);
          request.referenceManifest = reference.manifestPath;
          request.complete = reference.frames.filter(f => f.complete).length;
          assert(reference.status === "passed" && reference.completeSuccess && reference.waitVerified === false,
            reference.failure?.message ?? "Reference did not complete");
          ids = reference.frames.map(f => f.snapshotId!);
        } else {
          const response = await session.request(role === "C0" ? { name: "capture_ui", input: {
            sessionId: session.state.id, mode: "fast", backend: "accessibility-helper" } } : {
            name: "wait_for_ui", input: { sessionId: session.state.id, backend: "accessibility-helper", selector: { resourceId: id },
              state: "visible", additionalConditions: [{ selector: { resourceId: id }, state: "enabled" }], timeoutMs: 15_000 } }, signal);
          assert(!response.isError && !response.recordingWarning && !(response.recordingErrors as unknown[] | undefined)?.length,
            String(response.message ?? "Product operation failed"));
          const saved = reportFor(session).steps.find(s => s.step.id === response.stepId);
          assert(saved?.step.status === "done" && saved.after.freshness === "current" && saved.after.snapshotId === response.snapshotId);
          if (role === "W1") {
            assert(response.verified === true && saved.verified === true && saved.step.assertionConfirmation, "Strict wait proof missing");
            ids = [saved.step.assertionConfirmation.first.snapshotId, saved.step.assertionConfirmation.second.snapshotId];
          } else { assert.equal(saved.verified, null); ids = [String(response.snapshotId)]; }
        }
      } finally {
        // A throwing request still contributes its actual step IDs and observation attempts.
        request.stepIds = session.state.steps.filter(s => s.id > before).map(s => s.id);
        if (session.state.reportPath) try {
          const saved = reportFor(session).steps.filter(s => s.step.id > before);
          request.attempts = saved.reduce((n, s) => n + (s.step.timings?.observationCount ?? 0), 0);
        } catch (error) { request.auditError = String(error); }
        publish();
      }
      signal.throwIfAborted();
      assert.equal(ids.length, group.length); assert.equal(new Set(ids).size, group.length);
      assert.equal(request.attempts, group.length, "Extra observation/retry cannot count as first-full success");
      const raw = reportFor(session);
      assert(!request.auditError, request.auditError);
      assert.deepEqual(raw.limits, block.limits, "Chunk recording limits differ from frozen plan");
      assert(raw.session.id === session.state.id && raw.session.droppedSteps === 0 && raw.storage.bytes <= raw.limits.maxBytes);
      assert(raw.steps.every(s => !s.step.recordingErrors?.length && !s.step.inputEvidence && !s.step.dispatchState));
      assert(raw.snapshots.every(s => s.tree && s.screenshot && !s.warnings.length), "Missing/truncated attachment");
      const loaded = await loadTestReport(session.state.reportPath!, { preferredDebugStepIds: new Set(request.stepIds) });
      const steps = raw.steps.filter(s => request.stepIds.includes(s.step.id));
      const observed = steps.flatMap(saved => {
        const t = debugTimingsSchema.parse(saved.step.timings);
        assert(t.status === "success" && t.droppedSpans === 0);
        return t.spans.filter(s => s.phase === "observation").map(span => ({ saved, t, span }));
      });
      assert.equal(observed.length, ids.length);
      for (const [i, snapshotId] of ids.entries()) {
        const s = loaded.debug?.snapshots.find(s => s.evidence.snapshotId === snapshotId);
        assert(s?.snapshot && !s.treeError && !s.evidence.warnings.length);
        const image = loaded.images.find(image => image.artifactId === s.evidence.screenshot?.sha256 && image.dataUrl && !image.error);
        assert(image?.dataUrl);
        // Reports store the tree and verified original PNG separately; restore them only for the original safety checker.
        const snapshot = { ...s.snapshot, screenshotDataUrl: image.dataUrl }; assertSafeHelperObservationSnapshot(snapshot);
        const helper = snapshot.helperObservation!;
        assert.equal(snapshot.serial, target.serial); assert.equal(snapshot.nodeCount, target.nodeCounts[block.page]);
        assert.equal(snapshot.inspectionSource, "accessibility-helper"); assert.equal(helper.packageName, target.packageName);
        assert.equal(helper.serviceInstanceId, target.serviceId);
        assert.deepEqual(helper.displayBefore, { width: target.width, height: target.height, rotation: target.rotation });
        const { saved, t, span } = observed[i];
        assert(span.status === "success" && span.durationMs > 0);
        result.frames.push({ blockId: block.id, page: block.page, role: group[i], sessionId: session.state.id,
          stepId: saved.step.id, snapshotId, correlationId: t.correlationId, hostMs: span.durationMs,
          treeMs: helper.timing.hierarchyCompletedAtMs - helper.timing.hierarchyStartedAtMs,
          observationStartMs: Date.parse(t.startedAt) + span.startOffsetMs,
          observationEndMs: Date.parse(t.startedAt) + span.startOffsetMs + span.durationMs,
          helperPid: target.helperPid, serviceId: helper.serviceInstanceId });
      }
      assert(result.frames.every(f => f.treeMs > 0));
      request.complete = group.length; request.status = "passed"; publish(); position += group.length;
    }
    assert.deepEqual(result.frames.map(f => f.role), roles); result.status = "passed";
  } catch (error) {
    result.status = signal.aborted ? "cancelled" : "failed";
    result.failure = error instanceof Error ? error.message : String(error);
    result.failureCode = Date.parse(session.state.expiresAt) <= Date.now() ? "grant_expired"
      : error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "block_failed";
    const pending = result.requests.find(r => r.status === "running"); if (pending) pending.status = result.status;
  }
  publish(); return result;
}

export async function closeControlSession(session: DebugSession) {
  session.stop("隔离对照分片结束"); await session.settled();
  assert(!session.state.active && !session.hasPendingWork, "Session cleanup incomplete");
  const report = reportFor(session);
  assert(report.session.id === session.state.id && !report.session.active);
  return { sessionId: session.state.id, reportPath: session.state.reportPath!, directory: dirname(session.state.reportPath!), closed: true as const };
}
