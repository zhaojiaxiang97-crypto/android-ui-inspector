import assert from "node:assert/strict";
import { DEBUG_EVIDENCE_LIMITS, DEBUG_FINAL_TIMING_RESERVE_BYTES } from "../electron/automation/debug-evidence";
import type { DebugSessionReport } from "../shared/debug-report";

export const CONTROL = Object.freeze({ holdMs: 180_000, maxLagMs: 500, readyLeadMs: 10_000,
  authorizationPollMs: 1000, stageTimeoutMs: 8 * 60_000, chunkTimeoutMs: 60_000, stabilityPercent: 5,
  pairDelayMs: 350, referenceGapToleranceMs: 5 });
export const controlStages = ["Q1", "Q2", "I1", "I2", "I3", "I4"] as const;
export type ControlStage = typeof controlStages[number];
export type ControlPage = "small" | "large";
export type ControlTreatment = "A" | "B" | "C" | "D";
export type ControlRole = "C0" | "W1" | "W2" | "R1" | "R2";
export const treatments: Record<ControlTreatment, readonly ControlRole[]> = {
  A: ["C0", "W1", "W2"], B: ["W1", "W2", "C0"], C: ["C0", "R1", "R2"], D: ["R1", "R2", "C0"],
};
const orders: Record<string, { pages: ControlPage[]; order: ControlTreatment[] }> = {
  I1: { pages: ["small", "large"], order: ["A", "B", "D", "C"] },
  I2: { pages: ["large", "small"], order: ["B", "C", "A", "D"] },
  I3: { pages: ["small", "large"], order: ["C", "D", "B", "A"] },
  I4: { pages: ["large", "small"], order: ["D", "A", "C", "B"] },
};
// No image conversion: oversized original attachments FAIL. All matrix treatments use the same caps.
export const matrixLimits = Object.freeze({ ...DEBUG_EVIDENCE_LIMITS, maxImageBytes: 2 * 1024 * 1024 });
export type ControlBlock = { id: string; page: ControlPage; segment: "warmup" | "qualification" | "before" | "diagnostic" | "after";
  treatment: ControlTreatment; period: number; chunk: string; limits: Readonly<DebugSessionReport["limits"]> };
export type ControlFrame = { blockId: string; page: ControlPage; role: ControlRole; sessionId: string; stepId: number;
  snapshotId: string; correlationId: string; hostMs: number; treeMs: number; observationStartMs: number; observationEndMs: number;
  helperPid: number; serviceId: string };
export function controlPlan(stage: ControlStage): ControlBlock[] {
  assert(controlStages.includes(stage));
  const blocks: ControlBlock[] = [];
  const add = (page: ControlPage, segment: ControlBlock["segment"], treatment: ControlTreatment, period: number, chunk: string) =>
    blocks.push({ id: `${stage}-${blocks.length + 1}`, page, segment, treatment, period, chunk,
      limits: segment === "warmup" || stage.startsWith("Q") ? DEBUG_EVIDENCE_LIMITS : matrixLimits });
  for (let i = 0; i < 2; i++) for (const page of ["small", "large"] as const) add(page, "warmup", "A", i + 1, `${stage}-initial`);
  if (stage.startsWith("Q")) {
    for (const page of ["small", "large"] as const) for (let i = 0; i < 2; i++) add(page, "qualification", "A", i + 1, `${stage}-initial`);
  } else for (const page of orders[stage].pages) {
    for (let i = 0; i < 2; i++) add(page, "before", "A", i + 1, `${stage}-${page}-before`);
    for (const [i, treatment] of orders[stage].order.entries()) add(page, "diagnostic", treatment, i + 1, `${stage}-${page}-${treatment}`);
    for (let i = 0; i < 2; i++) add(page, "after", "A", i + 1, `${stage}-${page}-after`);
  }
  return blocks;
}
export function matrixChunkBudget(frames: number, limits: Readonly<DebugSessionReport["limits"]> = matrixLimits) {
  assert([3, 6].includes(frames), "Only fixed whole blocks or sentinels may be sliced");
  for (const [key, value] of Object.entries(limits)) assert(Number.isSafeInteger(value) && value > 0
    && value <= DEBUG_EVIDENCE_LIMITS[key as keyof typeof limits], "Original evidence caps cannot increase");
  const requiredBytes = frames * (limits.maxTreeBytes + limits.maxImageBytes + DEBUG_FINAL_TIMING_RESERVE_BYTES + 128 * 1024) + 128 * 1024;
  assert(requiredBytes <= limits.maxBytes && frames <= limits.maxSnapshots && frames <= limits.maxImages && frames <= limits.maxSteps,
    "Whole chunk cannot fit original quota with final timing reservation");
  return { frames, requiredBytes, maxBytes: limits.maxBytes, finalTimingReservePerFrame: DEBUG_FINAL_TIMING_RESERVE_BYTES };
}
function median(values: number[]) {
  assert(values.length && values.every(x => Number.isFinite(x) && x > 0), "Missing/invalid complete timing");
  const x = [...values].sort((a, b) => a - b), mid = Math.floor(x.length / 2);
  return x.length % 2 ? x[mid] : (x[mid - 1] + x[mid]) / 2;
}
export function controlDrift(first: number[], last: number[]) {
  const before = median(first), after = median(last);
  return { before, after, percent: 100 * (after - before) / before, accepted: Math.abs(after - before) <= before * 0.05 };
}
export function controlGate(frames: ControlFrame[]) {
  assert.equal(frames.length, 6, "Original gate requires exactly six frames");
  const host = controlDrift(frames.slice(0, 3).map(f => f.hostMs), frames.slice(3).map(f => f.hostMs));
  const tree = controlDrift(frames.slice(0, 3).map(f => f.treeMs), frames.slice(3).map(f => f.treeMs));
  return { accepted: host.accepted && tree.accepted, host, tree };
}
export function compareControlPages(first: ControlFrame[], last: ControlFrame[]) {
  const pages = (["small", "large"] as const).map(page => {
    const a = first.filter(f => f.page === page), b = last.filter(f => f.page === page);
    assert.equal(a.length, 6); assert.equal(b.length, 6);
    const host = controlDrift(a.map(f => f.hostMs), b.map(f => f.hostMs));
    const tree = controlDrift(a.map(f => f.treeMs), b.map(f => f.treeMs));
    return { page, host, tree, accepted: host.accepted && tree.accepted };
  });
  return { accepted: pages.every(p => p.accepted), pages };
}
export function stageGates(stage: ControlStage, frames: ControlFrame[]) {
  const plan = controlPlan(stage), measured = (segment: string, page?: ControlPage) => frames.filter(f =>
    plan.some(b => b.id === f.blockId && b.segment === segment && (!page || b.page === page)));
  const within = stage.startsWith("Q") ? (["small", "large"] as const).map(p => controlGate(measured("qualification", p)))
    : (["small", "large"] as const).flatMap(p => [controlGate(measured("before", p)), controlGate(measured("after", p))]);
  const between = stage.startsWith("Q") ? null : compareControlPages(measured("before"), measured("after"));
  return { accepted: within.every(g => g.accepted) && (!between || between.accepted), within, between };
}
