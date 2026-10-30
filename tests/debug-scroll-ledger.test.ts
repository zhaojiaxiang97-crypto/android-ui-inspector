import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DebugRequestLedger } from "../electron/automation/debug-request-ledger";
import type { DebugScrollProgress } from "../shared/debug-scroll";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "scroll-ledger-"));
  const options = { sessionDirectory: directory, sessionId: randomUUID() };
  const ledger = new DebugRequestLedger(options), requestId = randomUUID();
  ledger.reserve(requestId, { target: { selector: { resourceId: "list" } }, direction: "down" });
  const progress: DebugScrollProgress = { stopReason: "running", iterations: [], observationIds: [randomUUID()] };
  return { ledger, requestId, progress, options, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

function append(progress: DebugScrollProgress) {
  progress.iterations.push({ index: progress.iterations.length + 1, startedAt: new Date().toISOString(), durationMs: 0,
    beforeId: progress.observationIds.at(-1), dispatchState: "not_sent", progress: "unknown",
    resolvedInput: { action: { kind: "swipe", fromX: 500, fromY: 800, toX: 500, toY: 300, durationMs: 350 },
      frame: { width: 1080, height: 2400, rotation: 0 } } });
}

test("a later uncertain swipe is durably distinct from earlier accepted input", () => {
  const f = fixture();
  try {
    append(f.progress); f.ledger.checkpoint(f.requestId, f.progress, 1);
    f.progress.iterations[0].dispatchState = "unknown"; f.ledger.checkpoint(f.requestId, f.progress, 1);
    f.progress.iterations[0].dispatchState = "sent"; f.ledger.checkpoint(f.requestId, f.progress, 1);
    append(f.progress); f.ledger.checkpoint(f.requestId, f.progress, 1);
    assert.equal(f.ledger.get(f.requestId)!.dispatchState, "sent");
    f.progress.iterations[1].dispatchState = "unknown"; f.ledger.checkpoint(f.requestId, f.progress, 1);
    const disk = JSON.parse(readFileSync(f.ledger.path, "utf8")).records[0];
    assert.equal(disk.dispatchState, "unknown");
    assert.deepEqual(disk.progress.iterations.map((item: any) => item.dispatchState), ["sent", "unknown"]);
    f.progress.iterations[1].dispatchState = "sent"; f.ledger.checkpoint(f.requestId, f.progress, 1);
    f.progress.stopReason = "scroll_limit";
    f.ledger.finish(f.requestId, { verified: false, scrollTask: f.progress });
    assert.equal(f.ledger.get(f.requestId)!.dispatchState, "sent");
    assert.throws(() => f.ledger.checkpoint(f.requestId, f.progress, 1), /不能重新发送/);
  } finally { f.dispose(); }
});

test("a new unsent attempt cannot erase earlier input and finished traces cannot be rewritten", () => {
  const f = fixture();
  try {
    append(f.progress); f.progress.iterations[0].dispatchState = "sent";
    f.ledger.checkpoint(f.requestId, f.progress, 1);
    const rollback = structuredClone(f.progress); rollback.iterations[0].dispatchState = "not_sent";
    assert.throws(() => f.ledger.checkpoint(f.requestId, rollback, 1), /不能回退/);
    append(f.progress); f.ledger.checkpoint(f.requestId, f.progress, 1);
    assert.equal(f.ledger.get(f.requestId)!.dispatchState, "sent");
    const rewrite = structuredClone(f.progress); rewrite.iterations[0].durationMs = 999;
    assert.throws(() => f.ledger.checkpoint(f.requestId, rewrite, 1), /不可重写/);
    const truncated = structuredClone(f.progress); truncated.iterations.pop();
    assert.throws(() => f.ledger.checkpoint(f.requestId, truncated, 1), /不能丢失/);
    assert.throws(() => f.ledger.checkpoint(f.requestId, f.progress, 2), /另一个输入步骤/);
  } finally { f.dispose(); }
});

test("restart preserves per-gesture receipts and read-only recovery cannot lower aggregate uncertainty", () => {
  const f = fixture();
  try {
    append(f.progress); f.progress.iterations[0].dispatchState = "sent";
    f.ledger.checkpoint(f.requestId, f.progress, 1);
    const reloaded = new DebugRequestLedger(f.options), record = reloaded.get(f.requestId)!;
    assert.equal(record.state, "interrupted"); assert.equal(record.dispatchState, "unknown");
    assert.equal(record.progress!.iterations[0].dispatchState, "sent");
    const progress = structuredClone(record.progress!);
    progress.stopReason = "no_progress";
    reloaded.finish(f.requestId, { verified: false, resumed: true, scrollTask: progress });
    assert.equal(reloaded.get(f.requestId)!.dispatchState, "unknown");
    assert.throws(() => reloaded.checkpoint(f.requestId, progress, 1), /不能重新发送/);
  } finally { f.dispose(); }
});

test("ledger loss blocks the next gesture without reconstructing an empty journal", () => {
  const f = fixture();
  try {
    append(f.progress); f.progress.iterations[0].dispatchState = "sent";
    f.ledger.checkpoint(f.requestId, f.progress, 1);
    rmSync(f.ledger.path); append(f.progress); f.progress.iterations[1].dispatchState = "unknown";
    assert.throws(() => f.ledger.checkpoint(f.requestId, f.progress, 1));
  } finally { f.dispose(); }
});

test("dispatch locks target identity and coordinates while observation recovery only appends evidence", () => {
  const f = fixture();
  try {
    append(f.progress); f.progress.iterations[0].dispatchState = "unknown";
    f.ledger.checkpoint(f.requestId, f.progress, 1);
    const moved = structuredClone(f.progress); moved.observationIds.push(randomUUID());
    moved.iterations[0].beforeId = moved.observationIds.at(-1);
    assert.throws(() => f.ledger.checkpoint(f.requestId, moved, 1), /目标与坐标/);
    const removed = structuredClone(f.progress); removed.observationIds.unshift(randomUUID());
    assert.throws(() => f.ledger.checkpoint(f.requestId, removed, 1), /删除或重排/);
    const notSent = structuredClone(f.progress); notSent.iterations[0].dispatchState = "not_sent";
    assert.throws(() => f.ledger.checkpoint(f.requestId, notSent, 1), /必须保留未知/);
  } finally { f.dispose(); }
});

test("scroll progress is copied, bounded, and cannot introduce input while finishing an observation", () => {
  const f = fixture();
  try {
    append(f.progress); f.ledger.checkpoint(f.requestId, f.progress, 1);
    f.progress.iterations[0].durationMs = 42;
    assert.equal(f.ledger.get(f.requestId)!.progress!.iterations[0].durationMs, 0);
    const extra = f.ledger.get(f.requestId)!.progress!; append(extra);
    assert.throws(() => f.ledger.finish(f.requestId, { scrollTask: extra }), /不能丢失或跳过/);
    const tooMany = f.ledger.get(f.requestId)!.progress!;
    tooMany.observationIds = Array.from({ length: 257 }, () => randomUUID());
    assert.throws(() => f.ledger.checkpoint(f.requestId, tooMany, 1), /进度无效/);
  } finally { f.dispose(); }
});
