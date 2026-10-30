import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { DebugSession } from "../electron/automation/debug-session";
import { DebugEvidenceWriter } from "../electron/automation/debug-evidence";
import { loadTestReport } from "../electron/desktop/test-report";
import { measureDebugPhase } from "../electron/automation/debug-timing";
import { runUiRegression } from "../scripts/automation-ui-regression";
import { helperEvidenceSnapshot } from "./fixtures/helper-evidence";

test("checkpoint freezes each completed step before the next observation can evict its previous screenshot", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "checkpoint-retention-"));
  const serial = "helper-fixture", packageName = "com.example.helper";
  const condition = { selector: { resourceId: `${packageName}:id/result` }, state: "visible" };
  const target = { packageName, activityName: ".Main", component: `${packageName}/.Main`, windowId: "window", activityRecordId: "activity" };
  let reads = 0, inputs = 0, snapshotId = "";
  const session = new DebugSession({ serial, packageName, directory: join(directory, "product"),
    snapshotPath: join(directory, "current.json"), onEvent() {},
    observe: async () => measureDebugPhase("observation", async () => {
      const snapshot = helperEvidenceSnapshot({ startedAt: ++reads * 100 });
      snapshot.inspectionSource = "uiautomator"; delete snapshot.helperObservation; snapshot.hierarchyDumpMode = "full";
      const bytes = await sharp({ create: { width: 100, height: 200, channels: 3, background: { r: reads, g: 25, b: 75 } } }).png().toBuffer();
      snapshot.screenshotDataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
      return { snapshot, target };
    }, { backend: "uiautomator" }),
    input: async (_s, _t, _a, _f, _signal, onEvidence) => { inputs++; onEvidence?.({ classification: "accepted", spawned: true,
      closed: true, exitCode: 0, signal: null, durationMs: 1, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false }); } });
  const recording = (session as unknown as { recording: { directory: string; evidence: DebugEvidenceWriter } }).recording;
  recording.evidence = new DebugEvidenceWriter(recording.directory, session.state, { maxImages: 3 });
  const output = join(directory, "run");
  try {
    const result = await runUiRegression({ sessionId: session.state.id, outputDirectory: output,
      plan: { version: 1, id: "retention", serial, packageName, backend: "uiautomator", rounds: 3, maxDurationMs: 60_000,
        startConditions: [condition, { ...condition, state: "enabled" }], returnConditions: [condition],
        steps: [{ id: "back", kind: "step", input: { action: { kind: "back" }, expect: condition } }] },
      execute: async (command, args) => {
        if (command === "attach") return session.request({ name: "get_debug_session", input: {} });
        if (command === "find") return { snapshotId, total: 1 };
        const input = command === "step" ? JSON.parse(args[1]) : command === "capture"
          ? { sessionId: session.state.id, mode: "fast", backend: "uiautomator" }
          : { sessionId: session.state.id, selector: condition.selector, state: args[args.indexOf("--state") + 1], timeoutMs: 2000 };
        const value = await session.request({ name: command === "step" ? "perform_ui_step" : command === "capture" ? "capture_ui" : "wait_for_ui", input });
        if (typeof value.snapshotId === "string") snapshotId = value.snapshotId;
        return value;
      } });
    assert.equal(result.completeSuccess, true, JSON.stringify(result)); assert.equal(result.completedRounds, 3);
    assert.equal(inputs, 3); assert.equal(result.uncertainInputs, 0); assert.equal(result.evidence.missingScreenshots, 0);
    const source = JSON.parse(await readFile(session.state.reportPath!, "utf8"));
    assert.equal(source.limits.maxImages, 3); assert.equal(source.limits.maxBytes, 32 * 1024 * 1024);
    assert(source.snapshots.some((item: { screenshot: unknown }) => !item.screenshot), "the live history really was trimmed");
    const events = (await readFile(join(output, "samples.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const archives = events.filter(item => item.event === "archive"); assert.equal(archives.length, 18);
    session.stop(); await session.settled(); await rm(join(directory, "product"), { recursive: true, force: true });
    for (const item of archives) {
      assert.equal(item.evidence.complete, true);
      const loaded = await loadTestReport(item.reportPath);
      assert(loaded.images.length > 0 && loaded.images.every(image => image.dataUrl && !image.error));
      assert(loaded.debug!.snapshots.every(item => item.snapshot?.root && !item.treeError));
    }
  } finally { session.stop(); await session.settled(); await rm(directory, { recursive: true, force: true }); }
});
