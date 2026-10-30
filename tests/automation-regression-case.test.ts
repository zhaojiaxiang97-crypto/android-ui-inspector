import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { recordRegressionCase } from "../scripts/automation-regression-case";

const hashes = { sample: "1".repeat(64), helper: "2".repeat(64), boot: "3".repeat(64) };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "inspector-case-manifest-")), path = join(directory, "results.json");
  const record: Record<string, unknown> = { format: "fixture-case-v1", hashes, result: null };
  const options = { path, record, expectedHashes: () => hashes, run: async () => { record.result = { completeSuccess: true }; },
    readAfterHashes: () => ({ ...hashes }), readAnimationScale: () => "1.0" };
  return { directory, path, record, options, read: async () => JSON.parse(await readFile(path, "utf8")),
    clean: () => rm(directory, { recursive: true, force: true }) };
}

test("a failed run and disconnected end checks still persist the original failure without inventing end identity", async () => {
  const f = await fixture(), original = new Error("private runner failure");
  let identityQueries = 0, animationQueries = 0;
  try {
    await assert.rejects(recordRegressionCase({ ...f.options,
      run: async () => { f.record.result = { completeSuccess: false, stopCode: "foreground-query-failed", confirmedInputs: 1 }; throw original; },
      readAfterHashes: () => { identityQueries++; throw new Error("private disconnected device"); },
      readAnimationScale: () => { animationQueries++; throw new Error("private disconnected device"); },
    }), error => error === original);
    const saved = await f.read();
    assert.deepEqual(saved.result, { completeSuccess: false, stopCode: "foreground-query-failed", confirmedInputs: 1 });
    assert.equal(saved.afterHashes, null); assert.equal(saved.transitionAnimationScale, null);
    assert.deepEqual(saved.caseCompletion, { status: "finished", completeSuccess: false, runCompleted: false, runErrorCode: "case_run_failed",
      identityStatus: "unavailable", animationStatus: "unavailable" });
    assert.equal(identityQueries, 1); assert.equal(animationQueries, 1);
    assert(!JSON.stringify(saved).includes("private")); assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  } finally { await f.clean(); }
});

test("an identity mismatch is saved and rejects an otherwise successful run", async () => {
  const f = await fixture(), changed = { ...hashes, helper: "4".repeat(64) };
  try {
    await assert.rejects(recordRegressionCase({ ...f.options, readAfterHashes: () => changed }), /case_end_checks_failed/);
    const saved = await f.read(); assert.deepEqual(saved.afterHashes, changed);
    assert.equal(saved.caseCompletion.completeSuccess, false); assert.equal(saved.caseCompletion.identityStatus, "mismatch");
    assert.equal(saved.caseCompletion.animationStatus, "verified"); assert.equal(saved.result.completeSuccess, true);
  } finally { await f.clean(); }
});

test("an independent animation query failure or mismatch cannot turn into a pass or discard verified identity", async () => {
  for (const unavailable of [true, false]) {
    const f = await fixture();
    try {
      await assert.rejects(recordRegressionCase({ ...f.options, readAnimationScale: () => {
        if (unavailable) throw new Error("private query failure"); return "0.0";
      } }), /case_end_checks_failed/);
      const saved = await f.read(); assert.deepEqual(saved.afterHashes, hashes);
      assert.equal(saved.caseCompletion.identityStatus, "verified"); assert.equal(saved.caseCompletion.completeSuccess, false);
      assert.equal(saved.caseCompletion.animationStatus, unavailable ? "unavailable" : "mismatch");
    } finally { await f.clean(); }
  }
});

test("a successful run still fails closed if the end identity is unavailable", async () => {
  const f = await fixture();
  try {
    await assert.rejects(recordRegressionCase({ ...f.options, readAfterHashes: () => { throw new Error("disconnected"); } }), /case_end_checks_failed/);
    const saved = await f.read(); assert.equal(saved.afterHashes, null); assert.equal(saved.caseCompletion.completeSuccess, false);
    assert.equal(saved.caseCompletion.runCompleted, true);
  } finally { await f.clean(); }
});

test("valid end checks preserve successful acceptance and complete the durable manifest", async () => {
  const f = await fixture();
  try {
    await recordRegressionCase(f.options); const saved = await f.read();
    assert.equal(saved.caseCompletion.completeSuccess, true); assert.equal(saved.caseCompletion.runErrorCode, null);
    assert.deepEqual(saved.afterHashes, hashes); assert.equal(saved.transitionAnimationScale, "1.0");
  } finally { await f.clean(); }
});

test("end checks never promote a failed or missing runner result into success", async () => {
  for (const result of [null, { completeSuccess: false }, {}]) {
    const f = await fixture();
    try {
      await assert.rejects(recordRegressionCase({ ...f.options, run: async () => { f.record.result = result; } }), /case_end_checks_failed/);
      assert.equal((await f.read()).caseCompletion.completeSuccess, false);
    } finally { await f.clean(); }
  }
});

test("an unavailable evidence directory blocks all case work", async () => {
  const f = await fixture(); let runCalls = 0;
  try {
    await assert.rejects(recordRegressionCase({ ...f.options, path: join(f.directory, "missing", "results.json"),
      run: async () => { runCalls++; } }), (error: unknown) => {
      assert(error instanceof Error); assert.equal(error.message, "case_manifest_write_failed");
      return true;
    });
    assert.equal(runCalls, 0); await assert.rejects(readFile(f.path), { code: "ENOENT" });
  } finally { await f.clean(); }
});

test("a final persistence failure retains the original run error and never marks the reserved record complete", async () => {
  const f = await fixture(), original = new Error("fixture run failure");
  try {
    await assert.rejects(recordRegressionCase({ ...f.options, run: async () => {
      f.record.result = { invalidFixtureValue: BigInt(1) }; throw original;
    } }), (error: unknown) => {
      assert(error instanceof Error); assert.equal(error.message, "case_manifest_write_failed");
      assert.equal((error as Error & { errors: unknown[] }).errors[0], original); return true;
    });
    const saved = await f.read(); assert.equal(saved.caseCompletion.status, "running");
    assert.equal(saved.caseCompletion.completeSuccess, false);
  } finally { await f.clean(); }
});

test("a disconnected initial identity is saved without running an end-identity comparison", async () => {
  const f = await fixture(); let afterQueries = 0;
  try {
    const original = new Error("initial connection unavailable"); f.record.hashes = null;
    await assert.rejects(recordRegressionCase({ ...f.options, expectedHashes: () => null,
      run: async () => { throw original; }, readAfterHashes: () => { afterQueries++; return hashes; } }), error => error === original);
    const saved = await f.read(); assert.equal(saved.hashes, null); assert.equal(saved.afterHashes, null);
    assert.equal(saved.caseCompletion.identityStatus, "unavailable"); assert.equal(afterQueries, 0);
    assert.equal(saved.caseCompletion.completeSuccess, false);
  } finally { await f.clean(); }
});

test("existing case evidence is never overwritten", async () => {
  const f = await fixture(); let runCalls = 0;
  try {
    await writeFile(f.path, "existing evidence", { flag: "wx" });
    await assert.rejects(recordRegressionCase({ ...f.options, run: async () => { runCalls++; } }), /case_manifest_write_failed/);
    assert.equal(runCalls, 0);
    assert.equal(await readFile(f.path, "utf8"), "existing evidence");
  } finally { await f.clean(); }
});
