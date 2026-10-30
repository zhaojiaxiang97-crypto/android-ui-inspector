import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DebugSession } from "../electron/automation/debug-session";
import { CONTROL, controlStages, controlPlan, controlGate, controlDrift, compareControlPages, matrixChunkBudget, treatments, matrixLimits,
  type ControlBlock, type ControlFrame } from "../scripts/capture-control-protocol";
import { runCaptureControlStudy, type ControlClock, type ControlPorts } from "../scripts/capture-control-driver";
import type { executeControlBlock, ControlBlockResult } from "../scripts/capture-control-session";
import { DEBUG_EVIDENCE_LIMITS } from "../electron/automation/debug-evidence";

function frames(block: ControlBlock, sessionId: string = randomUUID()): ControlFrame[] {
  return treatments[block.treatment].map((role, i) => ({ blockId: block.id, page: block.page, role, sessionId, stepId: i + 1,
    snapshotId: randomUUID(), correlationId: randomUUID(), hostMs: 100, treeMs: 50, observationStartMs: i * 1000,
    observationEndMs: i * 1000 + 100, helperPid: 1, serviceId: randomUUID() }));
}
function rehearsal(options: { mutate?: (block: ControlBlock, result: ControlBlockResult) => void;
  qualificationOnly?: true;
  authAtMs?: number; armLagMs?: number; sleepLagMs?: number; readyDelayMs?: number; reuseProcess?: boolean;
  signal?: AbortSignal; execute?: typeof executeControlBlock; blockDelayMs?: number; quietFailure?: boolean } = {}) {
  const evidence = process.env.INSPECTOR_CONTROL_OFFLINE_EVIDENCE;
  if (evidence) mkdirSync(evidence, { recursive: true });
  const directory = realpathSync(mkdtempSync(join(evidence ?? tmpdir(), "capture-control-driver-")));
  let now = 1_000_000, identity: Awaited<ReturnType<ControlPorts["identity"]>>, preparations = 0;
  const sessions: DebugSession[] = [], chunks: string[] = [], events: string[] = [];
  const clock: ControlClock = { now: () => now, sleep: async ms => { now += ms + (options.sleepLagMs ?? 0); } };
  const ports: ControlPorts = {
    prepare: async stage => {
      preparations++; events.push("prepare:" + stage);
      identity = { serial: "offline-device", packageName: "com.example.fixture", helperPid: options.reuseProcess ? 1 : preparations,
        serviceId: randomUUID(), width: 10, height: 20, rotation: 0, nodeCounts: { small: 2, large: 2 }, selectors: { small: "page", large: "page" },
        helperSha256: "frozen-helper", appSha256: "frozen-app", bootId: "frozen-boot" };
      const processReadyMs = now; now += options.armLagMs ?? 0; return { processReadyMs, identity };
    },
    identity: async () => identity,
    ready: async page => { events.push("ready:" + page); now += options.readyDelayMs ?? 0; },
    quiet: async () => { events.push("quiet"); if (options.quietFailure) throw Error("Competing test/build detected"); },
    session: async specification => {
      events.push("auth"); if (options.authAtMs !== undefined && now < options.authAtMs) return null;
      chunks.push(specification.id);
      const session = new DebugSession({ directory: specification.directory, snapshotPath: join(specification.directory, "snapshot.json"),
        serial: identity.serial, packageName: identity.packageName, observe: async () => { throw Error("Rehearsal must not observe a device"); },
        input: async () => { throw Error("Rehearsal must not input"); }, onEvent: () => {}, recordingLimits: specification.limits });
      sessions.push(session); return session;
    },
  };
  const executor: typeof executeControlBlock = async (session, block, target, signal, checkpoint, before) => {
    signal.throwIfAborted(); before?.(); events.push("block:" + block.id);
    const f = frames(block, session.state.id).map(x => ({ ...x, helperPid: target.helperPid, serviceId: target.serviceId }));
    const result: ControlBlockResult = { blockId: block.id, status: "passed", sessionId: session.state.id, reportPath: null,
      wallMs: 650, frames: f, requests: [{ roles: f.map(x => x.role), stepIds: [1, 2], attempts: 3, complete: 3, status: "passed" }] };
    options.mutate?.(block, result); checkpoint(result); now += options.blockDelayMs ?? 650; return result;
  };
  return { directory, sessions, chunks, events, counts: () => ({ preparations, now }),
    run: () => runCaptureControlStudy({ directory, offlineOnly: true, ports, qualificationOnly: options.qualificationOnly,
      clock, signal: options.signal, offlineExecutor: options.execute ?? executor }),
    async dispose() { for (const s of sessions) { s.stop(); await s.settled(); }
      if (!evidence) rmSync(directory, { recursive: true, force: true }); } };
}

test("frozen matrix has 288 frames and fixed whole-block/sentinel session slices", () => {
  const plans = controlStages.map(controlPlan); assert.deepEqual(plans.map(p => p.length * 3), [24, 24, 60, 60, 60, 60]);
  assert.equal(plans.flat().length * 3, 288);
  assert.deepEqual(plans.map(p => new Set(p.map(b => b.chunk)).size), [1, 1, 13, 13, 13, 13]);
  for (const plan of plans) for (const block of plan) {
    assert.deepEqual(treatments[block.treatment].filter(r => r.startsWith("W")), block.treatment === "A" || block.treatment === "B" ? ["W1", "W2"] : []);
    if (block.segment === "warmup") assert.equal(block.treatment, "A");
  }
});
test("Williams ordering balances periods, directed neighbors and page order", () => {
  const rows = controlStages.slice(2).map(s => controlPlan(s).filter(b => b.segment === "diagnostic" && b.page === (s === "I2" || s === "I4" ? "large" : "small")));
  for (let i = 0; i < 4; i++) assert.equal(new Set(rows.map(r => r[i].treatment)).size, 4);
  const neighbors = rows.flatMap(r => r.slice(1).map((b, i) => r[i].treatment + b.treatment));
  assert.equal(new Set(neighbors).size, 12);
  assert.deepEqual(rows.map(r => r.map(b => b.treatment).join("")), ["ABDC", "BCAD", "CDBA", "DACB"]);
});
test("six-frame chunks reserve final timings below unchanged 32 MiB; original max attachments cannot fit three frames", () => {
  assert.equal(matrixChunkBudget(6).requiredBytes, 29_235_200);
  assert.equal(matrixLimits.maxBytes, 33_554_432); assert.equal(matrixLimits.maxImageBytes, 2_097_152);
  assert.throws(() => matrixChunkBudget(3, DEBUG_EVIDENCE_LIMITS), /cannot fit/);
  assert.throws(() => matrixChunkBudget(4), /whole blocks/);
  assert.throws(() => matrixChunkBudget(6, { ...matrixLimits, maxBytes: 33_554_433 }), /cannot increase/);
});
test("original inclusive 5% gate rejects both directions and the frozen -6.584% tree failure", () => {
  assert(controlDrift([100], [105]).accepted); assert(controlDrift([100], [95]).accepted);
  assert(!controlDrift([100], [105.000001]).accepted); assert(!controlDrift([100], [94.999999]).accepted);
  assert(!controlDrift([243, 219, 246], [242, 227, 223]).accepted);
  const block = controlPlan("Q1")[4], six = [...frames(block), ...frames(block)];
  assert(controlGate(six).accepted); six[3].treeMs = six[4].treeMs = six[5].treeMs = 47;
  assert(!controlGate(six).accepted); assert.throws(() => controlGate(six.slice(1)));
  const pages = (["small", "large"] as const).flatMap(page => six.map(f => ({ ...f, page, treeMs: 50 })));
  assert(compareControlPages(pages, pages).accepted); assert.throws(() => compareControlPages(pages.slice(1), pages));
});
test("offline full rehearsal waits 180s per independent process, keeps 54 sessions and archives every stage", async () => {
  const h = rehearsal(); try {
    const r = await h.run(); assert.equal(r.status, "passed", r.failure ?? "");
    assert.equal(r.actualDeviceSamples, 0); assert.equal(r.referenceGapMatched, null); assert.equal(r.overheadPassed, null);
    assert.deepEqual(r.stages.map(s => s.counts), [{ attempts: 24, complete: 24 }, { attempts: 24, complete: 24 },
      ...Array.from({ length: 4 }, () => ({ attempts: 60, complete: 60 }))]);
    assert.equal(h.sessions.length, 54); assert(h.sessions.every(s => !s.state.active && !s.hasPendingWork));
    for (const stage of r.stages) {
      assert.equal(stage.firstDispatchMs! - stage.processReadyMs!, CONTROL.holdMs);
      assert(stage.sessions.every(s => s.closed && s.reportPath && s.closedMs));
    }
    assert(h.events.indexOf("prepare:I1") > h.events.indexOf("block:Q2-8"));
    assert.equal(JSON.parse(readFileSync(r.manifestPath, "utf8")).status, "passed");
    const before = readFileSync(r.manifestPath); await assert.rejects(h.run(), /EEXIST/); assert.deepEqual(readFileSync(r.manifestPath), before);
  } finally { await h.dispose(); }
});
test("automatic grant polling does not move the 180-second deadline", async () => {
  const h = rehearsal({ authAtMs: 1_005_000 }); try {
    const r = await h.run(); assert.equal(r.status, "passed");
    assert.equal(r.stages[0].firstDispatchMs, 1_180_000); assert(h.events.filter(e => e === "auth").length > 54);
  } finally { await h.dispose(); }
});
test("qualification-only finishes Q1/Q2 and closes both sessions without preparing a matrix process", async () => {
  const h = rehearsal({ qualificationOnly: true }); try {
    const r = await h.run(); assert.equal(r.status, "passed", r.failure ?? "");
    assert.equal(r.scope, "qualification-only"); assert.equal(r.plannedFrames, 48);
    assert.deepEqual(r.stages.map(s => s.stage), ["Q1", "Q2"]);
    assert(r.stages.every(s => s.counts.attempts === 24 && s.counts.complete === 24 && s.gate?.accepted));
    assert(r.stages[1].crossQualification?.accepted); assert.equal(h.counts().preparations, 2);
    assert.equal(h.sessions.length, 2); assert(h.sessions.every(s => !s.state.active));
    assert(!h.events.includes("prepare:I1"));
  } finally { await h.dispose(); }
});
for (const failingStage of ["Q1", "Q2"] as const) test(`qualification-only ${failingStage} gate failure stops without replacement samples`, async () => {
  const h = rehearsal({ qualificationOnly: true, mutate: (b, r) => {
    if (b.id === `${failingStage}-6`) r.frames.forEach(f => f.treeMs = 47);
  } }); try {
    const r = await h.run(); assert.equal(r.status, "failed");
    assert.equal(h.counts().preparations, failingStage === "Q1" ? 1 : 2);
    const failed = r.stages.find(s => s.stage === failingStage)!;
    assert.equal(failed.counts.attempts, 18); assert(!h.events.includes(`block:${failingStage}-7`));
    assert(!h.events.includes("prepare:I1"));
    assert(h.sessions.every(s => !s.state.active));
  } finally { await h.dispose(); }
});
test("qualification-only preserves the original independent-process 5% failure", async () => {
  const h = rehearsal({ qualificationOnly: true, mutate: (b, r) => {
    if (b.id.startsWith("Q2-") && b.segment === "qualification") r.frames.forEach(f => f.hostMs = 106);
  } }); try {
    const r = await h.run(); assert.equal(r.status, "failed");
    assert.equal(r.stages[1].crossQualification?.accepted, false);
    assert.deepEqual(r.stages.map(s => s.counts.attempts), [24, 24]);
    assert.equal(h.counts().preparations, 2);
  } finally { await h.dispose(); }
});
for (const [name, options] of [
  ["authorization misses preparation boundary", { authAtMs: 2_000_000 }],
  ["driver starts after rebuild allowance", { armLagMs: 501 }],
  ["actual first request misses 500ms allowance", { sleepLagMs: 501 }],
  ["page preparation consumes fixed lead", { readyDelayMs: 170_001 }],
] as const) test(name + " leaves failure without sampling or rescheduling", async () => {
  const h = rehearsal(options); try {
    const r = await h.run(); assert.equal(r.status, "failed"); assert.equal(h.counts().preparations, 1);
    assert.equal(r.stages[0].counts.attempts, 0); assert(r.stages.slice(1).every(s => s.status === "pending"));
    assert(h.sessions.every(s => !s.state.active));
    assert.equal(JSON.parse(readFileSync(r.manifestPath, "utf8")).status, "failed");
  } finally { await h.dispose(); }
});
test("Q1 small-page gate failure stops before large measured page and preserves previous failures", async () => {
  const h = rehearsal({ mutate: (b, r) => { if (b.id === "Q1-6") r.frames.forEach(f => f.treeMs = 47); } });
  try {
    const r = await h.run(); assert.equal(r.status, "failed"); assert.equal(h.counts().preparations, 1);
    assert.equal(r.stages[0].frames.length, 18); assert(!h.events.includes("block:Q1-7"));
    assert.equal(r.stages[0].sessions[0].closed, true);
  } finally { await h.dispose(); }
});
test("Q2 independent-process drift blocks I1 even when both within-page gates pass", async () => {
  const h = rehearsal({ mutate: (b, r) => { if (b.id.startsWith("Q2-") && b.segment === "qualification") r.frames.forEach(f => f.hostMs = 106); } });
  try {
    const r = await h.run(); assert.equal(r.status, "failed"); assert.equal(h.counts().preparations, 2);
    assert.equal(r.stages[1].crossQualification?.accepted, false); assert(!h.events.includes("prepare:I1"));
  } finally { await h.dispose(); }
});
test("sentinel pre/post drift stops matrix before the next page", async () => {
  const h = rehearsal({ mutate: (b, r) => { if (b.id.startsWith("I1-") && b.page === "small" && b.segment === "after") r.frames.forEach(f => f.treeMs = 53); } });
  try { const r = await h.run(); assert.equal(r.status, "failed"); assert.equal(h.counts().preparations, 3);
    assert.equal(r.stages[2].frames.length, 36); assert(!h.events.includes("block:I1-13"));
  } finally { await h.dispose(); }
});
test("reused Helper process stops Q2 without invoking a collector", async () => {
  const h = rehearsal({ reuseProcess: true }); try {
    const r = await h.run(); assert.equal(r.status, "failed"); assert.equal(r.stages[1].counts.attempts, 0);
  } finally { await h.dispose(); }
});
test("aborted collection stops, closes and independently indexes the current session", async () => {
  const controller = new AbortController();
  const h = rehearsal({ signal: controller.signal, mutate: () => controller.abort(new Error("offline cancellation")) });
  try { const r = await h.run(); assert.equal(r.status, "cancelled"); assert.equal(h.counts().preparations, 1);
    assert(r.stages[0].sessions[0].closed); assert(h.sessions.every(s => !s.state.active));
  } finally { await h.dispose(); }
});
test("partial failed block retains actual attempt count and closed report, without retry", async () => {
  const h = rehearsal({ mutate: (_b, r) => { r.status = "failed"; r.failure = "offline fault"; r.frames = [];
    r.requests[0].attempts = 1; r.requests[0].complete = 0; r.requests[0].status = "failed"; } });
  try { const r = await h.run(); assert.equal(r.status, "failed"); assert.deepEqual(r.stages[0].counts, { attempts: 1, complete: 0 });
    assert.equal(r.stages[0].sessions.length, 1); assert(r.stages[0].sessions[0].reportPath);
    assert.equal(r.stages[0].blocks.filter(b => b.result).length, 1);
  } finally { await h.dispose(); }
});
test("foreign index replacement is never overwritten and cleanup still runs", async () => {
  let h: ReturnType<typeof rehearsal>;
  h = rehearsal({ mutate: () => writeFileSync(join(h.directory, "study.json"), "foreign content") });
  try { await assert.rejects(h.run(), /index changed/); assert.equal(readFileSync(join(h.directory, "study.json"), "utf8"), "foreign content");
    assert(h.sessions.every(s => !s.state.active && !s.hasPendingWork));
  } finally { await h.dispose(); }
});
test("quiet preflight failure blocks collection and is independently archived", async () => {
  const h = rehearsal({ quietFailure: true }); try {
    const r = await h.run(); assert.equal(r.status, "failed"); assert.equal(r.stages[0].counts.attempts, 0);
    assert(r.stages[0].sessions[0].closed); assert.match(r.failure!, /Competing test\/build/);
  } finally { await h.dispose(); }
});
test("overall deadline includes conditioning and never restarts after a slow block", async () => {
  const h = rehearsal({ blockDelayMs: 400_000 }); try {
    const r = await h.run(); assert.equal(r.status, "failed"); assert.equal(r.stages[0].counts.attempts, 3);
    assert.match(r.failure!, /deadline/); assert.equal(h.counts().preparations, 1);
  } finally { await h.dispose(); }
});
