import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { compareDebugTaskRuns } from "../shared/debug-task-comparison";
import { makeDebugTaskComparisonFixture, comparisonDefinition } from "./fixtures/debug-task-comparison";

test("different task UUIDs and devices align only identical complete normalized definitions", async () => {
  const a = makeDebugTaskComparisonFixture(), definition = comparisonDefinition();
  definition.goal = `  ${definition.goal}  `; definition.checkpoints[0].title = ` ${definition.checkpoints[0].title} `;
  definition.checkpoints[0].conditions[0].selector = { className: "android.widget.TextView", text: "设置" };
  const b = makeDebugTaskComparisonFixture({ seed: 1000, serial: "second-device", definition, scale: 2, offsetMs: 100_000 });
  try {
    a.complete(); b.complete(true);
    const originalA = readFileSync(a.file), originalB = readFileSync(b.file), primary = await a.load(), secondary = await b.load();
    const result = compareDebugTaskRuns(primary, secondary);
    assert.equal(result.status, "same_task"); assert.notEqual(result.primary.source.taskId, result.secondary.source.taskId);
    assert.equal(result.secondary.source.serial, "second-device"); assert.equal(result.rows.length, 3);
    assert.equal(result.rows[0].primary.status, "passed"); assert.equal(result.rows.at(-1)!.primary.status, "passed");
    assert.equal(result.rows.at(-1)!.secondary.status, "failed");
    assert.deepEqual(result.rows.at(-1)!.secondary.conditions.filter(value => value.status === "failed").map(value => value.id), ["saved-visible", "error-absent"]);
    assert.equal(result.rows[0].primary.time.milliseconds, 600); assert.equal(result.rows[0].secondary.time.milliseconds, 1200); assert.equal(result.rows[0].differenceMs, 600);
    assert.equal(result.primary.time.milliseconds, 4600); assert.equal(result.secondary.time.milliseconds, 9200); assert.equal(result.differenceMs, 4600);
    assert.match(result.secondary.time.reason, /最近最终检查/); assert.doesNotMatch(result.secondary.time.reason, /任务完成/);
    assert.equal(JSON.stringify(result).includes("firstNodeId"), false); assert.equal(JSON.stringify(result).includes("screenshotArtifactId"), false);
    assert.deepEqual(readFileSync(a.file), originalA); assert.deepEqual(readFileSync(b.file), originalB);
  } finally { a.cleanup(); b.cleanup(); }
});

test("goal alone, stage order, condition IDs/order, title, selectors and states cannot mix different definitions", async () => {
  const primaryFixture = makeDebugTaskComparisonFixture();
  try {
    primaryFixture.complete(); const primary = await primaryFixture.load();
    const changes = [
      (value: ReturnType<typeof comparisonDefinition>) => { value.goal += "不同目标"; },
      (value: ReturnType<typeof comparisonDefinition>) => { value.checkpoints.reverse(); },
      (value: ReturnType<typeof comparisonDefinition>) => { value.checkpoints[0].id = "different-stage"; },
      (value: ReturnType<typeof comparisonDefinition>) => { value.checkpoints[0].title = "重新命名"; },
      (value: ReturnType<typeof comparisonDefinition>) => { value.finalConditions.reverse(); },
      (value: ReturnType<typeof comparisonDefinition>) => { value.finalConditions[0].id = "different-condition"; },
      (value: ReturnType<typeof comparisonDefinition>) => { value.finalConditions[0].selector.text = "其他值"; },
      (value: ReturnType<typeof comparisonDefinition>) => { value.finalConditions[0].state = "disabled"; },
    ];
    for (const change of changes) {
      const definition = comparisonDefinition(); change(definition); const f = makeDebugTaskComparisonFixture({ seed: 2000, definition });
      try { const result = compareDebugTaskRuns(primary, await f.load()); assert.equal(result.status, "different_definition"); assert.deepEqual(result.rows, []); assert.ok(result.reasons.length); assert.equal(result.differenceMs, null); }
      finally { f.cleanup(); }
    }
    const f = makeDebugTaskComparisonFixture({ packageName: "another.app", definition: comparisonDefinition() });
    try { const result = compareDebugTaskRuns(primary, await f.load()); assert.equal(result.status, "different_app"); assert.deepEqual(result.rows, []); }
    finally { f.cleanup(); }
  } finally { primaryFixture.cleanup(); }
});

test("missing trees and incomplete latest proofs remain insufficient despite original passed records", async () => {
  const a = makeDebugTaskComparisonFixture(), b = makeDebugTaskComparisonFixture({ seed: 3000 });
  try {
    a.complete(); const final = b.complete();
    rmSync(join(b.directory, b.report.snapshots.find(value => value.snapshotId === final.observations.second!.snapshotId)!.tree!.path));
    const primary = await a.load(), secondary = await b.load(), result = compareDebugTaskRuns(primary, secondary);
    assert.equal(secondary.debug!.task!.checks.at(-1)!.status, "passed");
    assert.equal(result.rows.at(-1)!.secondary.status, "insufficient_evidence");
    assert.equal(result.rows.at(-1)!.secondary.reason, secondary.debug!.taskAssessment!.final!.reason);
    assert.match(result.secondary.time.reason, /最近最终检查/); assert.equal(result.secondary.time.milliseconds, 4600);
    delete secondary.debug!.taskAssessment;
    assert.ok(compareDebugTaskRuns(primary, secondary).rows.every(row => row.secondary.status === "insufficient_evidence"));
    const loaded = await a.load(); loaded.debug!.taskAssessment!.checks[0].recorded = { ...loaded.debug!.taskAssessment!.checks[0].recorded, checkedAt: "2026-10-12T09:00:00.000Z" };
    assert.equal(compareDebugTaskRuns(primary, loaded).rows[0].secondary.status, "insufficient_evidence");
  } finally { a.cleanup(); b.cleanup(); }
});

test("a valid checkpoint named final stays separate from the final evaluation", async () => {
  const definition = comparisonDefinition(); definition.checkpoints[0].id = "final";
  const a = makeDebugTaskComparisonFixture({ definition }), b = makeDebugTaskComparisonFixture({ seed: 6000, definition });
  try {
    a.complete(); b.complete(true); const result = compareDebugTaskRuns(await a.load(), await b.load());
    assert.equal(result.status, "same_task"); assert.equal(result.rows[0].id, "final"); assert.equal(result.rows.at(-1)!.id, null);
    assert.equal(result.rows[0].secondary.status, "passed"); assert.equal(result.rows.at(-1)!.secondary.status, "failed");
  } finally { a.cleanup(); b.cleanup(); }
});

test("unperformed stages and final checks are unchecked, and updatedAt is never an execution end", async () => {
  const a = makeDebugTaskComparisonFixture(), b = makeDebugTaskComparisonFixture({ seed: 4000 });
  try {
    a.complete(); b.addCheck("settings"); const primary = await a.load(), secondary = await b.load();
    secondary.debug!.session.updatedAt = "2027-01-01T00:00:00.000Z";
    const result = compareDebugTaskRuns(primary, secondary);
    assert.equal(result.rows[0].secondary.status, "passed"); assert.equal(result.rows[1].secondary.status, "unchecked");
    assert.equal(result.rows.at(-1)!.secondary.status, "unchecked"); assert.equal(result.secondary.time.milliseconds, null); assert.equal(result.differenceMs, null);
    assert.equal(result.rows[0].secondary.time.milliseconds, 600);
  } finally { a.cleanup(); b.cleanup(); }
});

test("rolling step loss keeps reviewed outcomes but makes check duration unknown; task range uses definition and final check timestamps", async () => {
  const a = makeDebugTaskComparisonFixture(), b = makeDebugTaskComparisonFixture({ seed: 5000 });
  try {
    a.complete(); b.complete(); b.report.steps = b.report.steps.slice(-1); b.report.session.droppedSteps = 3; b.save();
    const result = compareDebugTaskRuns(await a.load(), await b.load());
    assert.ok(result.rows.every(row => row.secondary.status === "passed")); assert.equal(result.rows[0].secondary.time.milliseconds, null);
    assert.match(result.rows[0].secondary.time.reason, /未保留/); assert.equal(result.rows.at(-1)!.secondary.time.milliseconds, 600); assert.equal(result.secondary.time.milliseconds, 4600);
    const primary = await a.load(), changed = structuredClone(primary);
    changed.debug!.steps.forEach(entry => { entry.durationMs = 999999; }); changed.debug!.session.updatedAt = "2030-01-01T00:00:00.000Z";
    const unchanged = compareDebugTaskRuns(primary, changed); assert.equal(unchanged.differenceMs, 0); assert.ok(unchanged.rows.every(row => row.differenceMs === 0));
  } finally { a.cleanup(); b.cleanup(); }
});

test("reports without full task definitions never fabricate an alignment", async () => {
  const a = makeDebugTaskComparisonFixture();
  try {
    a.complete(); const primary = await a.load(), legacy = structuredClone(primary); delete legacy.debug!.task; delete legacy.debug!.taskAssessment;
    assert.equal(compareDebugTaskRuns(primary, legacy).status, "missing_task");
    const incomplete = structuredClone(primary); incomplete.debug!.task!.definition.finalConditions = [];
    assert.equal(compareDebugTaskRuns(primary, incomplete).status, "missing_task");
    delete legacy.debug; assert.equal(compareDebugTaskRuns(primary, legacy).rows.length, 0);
  } finally { a.cleanup(); }
});
