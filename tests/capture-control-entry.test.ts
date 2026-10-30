import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlEntryFault, captureControlConfig, controlFingerprint, createControlJournal, readControlJson,
  recoverCaptureControlEntry, runCaptureControlEntry } from "../scripts/capture-control-entry";
import { isCaptureControlMain, launchCaptureControl, parseCaptureControlArguments } from "../scripts/capture-control-launch";
import { runCaptureControlStudy } from "../scripts/capture-control-driver";
import { DebugSession } from "../electron/automation/debug-session";
import { entryFixture, entrySha } from "./fixtures/capture-control-entry";

const recoveryOrder = ["sessions", "packages", "pairing", "settings", "forwards", "dispose"];
test("isolated CLI requires explicit execution/config, rejects duplicates, unknown commands and relative paths", () => {
  for (const args of [[], ["--config", "/tmp/c.json"], ["--execute-isolated"], ["--execute-isolated", "--config", "relative"],
    ["--execute-isolated", "--execute-isolated"], ["--execute-isolated", "--config", "/tmp/x", "--input", "tap"]]) assert.throws(() => parseCaptureControlArguments(args));
  assert.deepEqual(parseCaptureControlArguments(["--config", "/tmp/config.json", "--execute-isolated", "--recover-only"]), { configPath: "/tmp/config.json", recoveryOnly: true });
});
test("Electron launches only its actual entry; importing the module or running a renderer remains inert", () => {
  const entry = { launchCaptureControl };
  assert(isCaptureControlMain(true));
  assert(isCaptureControlMain(false, "browser", entry));
  assert(!isCaptureControlMain(false, "browser", { launchCaptureControl: () => {} }));
  assert(!isCaptureControlMain(false, "browser", {}));
  assert(!isCaptureControlMain(false, "browser", null));
  assert(!isCaptureControlMain(false, "browser"));
  assert(!isCaptureControlMain(false, "renderer", entry));
  assert(!isCaptureControlMain(false, undefined, entry));
});
test("frozen config binds exact device, self-owned fixture, artifacts and sources", () => {
  const h = entryFixture(); try {
    assert(captureControlConfig.safeParse(h.config).success);
    for (const patch of [{ serial: "other" }, { packageName: "com.business.app" }, { runDirectory: "relative" }, { sources: [] }, { arbitraryCommand: "input tap" }])
      assert(!captureControlConfig.safeParse({ ...h.config, ...patch }).success);
  } finally { h.dispose(); }
});
test("successful offline entry separately archives all six recovery steps", async () => {
  const h = entryFixture(); try {
    const r = await runCaptureControlEntry(h.config, h.platform, { offlineOnly: true, study: h.syntheticStudy });
    assert.equal(r.status, "passed"); assert(r.recoveryPassed); assert.deepEqual(h.events, ["preflight", "study", ...recoveryOrder]);
    const saved = readControlJson(r.recoveryPath!); assert.equal(saved.steps.length, 6);
    for (const step of saved.steps) { assert(existsSync(step.path)); assert.equal(readControlJson(step.path).status, "passed"); }
  } finally { h.dispose(); }
});
test("qualification scope is frozen into config and passed to study; recovery cannot change scope", async () => {
  const h = entryFixture(); try {
    const config = { ...h.config, qualificationOnly: true as const };
    assert(captureControlConfig.safeParse(config).success);
    assert(!captureControlConfig.safeParse({ ...config, qualificationOnly: false }).success);
    assert.notEqual(controlFingerprint(config), controlFingerprint(h.config));
    const r = await runCaptureControlEntry(config, h.platform, { offlineOnly: true, study: options => {
      assert.equal(options.qualificationOnly, true); return h.syntheticStudy(options);
    } });
    assert.equal(r.status, "passed"); assert(r.recoveryPassed);
    await assert.rejects(recoverCaptureControlEntry(h.config, h.platform), /scope\/config changed/);
  } finally { h.dispose(); }
});
test("new run reservation rejects old directories before any platform operation", async () => {
  const h = entryFixture(); try { mkdirSync(h.config.runDirectory); writeFileSync(join(h.config.runDirectory, "old-failure.json"), "old bytes");
    await assert.rejects(runCaptureControlEntry(h.config, h.platform, { offlineOnly: true, study: h.syntheticStudy }), /EEXIST/);
    assert.deepEqual(h.events, []); assert.equal(readFileSync(join(h.config.runDirectory, "old-failure.json"), "utf8"), "old bytes");
  } finally { h.dispose(); }
});
test("real study preparation disconnect persists failure and still runs every recovery step", async () => {
  const h = entryFixture(); try {
    h.platform.ports.prepare = async () => { throw new ControlEntryFault("transport_disconnected"); };
    const r = await runCaptureControlEntry(h.config, h.platform, { offlineOnly: true });
    assert.equal(r.status, "failed"); assert.equal(r.failure?.code, "transport_disconnected"); assert(r.recoveryPassed);
    const study = readControlJson(r.studyPath); assert.equal(study.status, "failed"); assert.equal(study.actualDeviceSamples, 0);
    assert.deepEqual(study.stages[0].counts, { attempts: 0, complete: 0 });
    assert.deepEqual(h.events, ["preflight", ...recoveryOrder]); assert.equal(readControlJson(join(h.config.runDirectory, "entry.json")).failure.code, "transport_disconnected");
  } finally { h.dispose(); }
});
test("expired real session blocks all observations and records grant_expired through both indexes", async () => {
  const h = entryFixture(); let session: DebugSession | undefined, observations = 0, now = 1_000_000;
  try {
    const identity = { serial: h.config.serial, packageName: h.config.packageName, helperPid: 100, serviceId: randomUUID(), width: 1080, height: 2400,
      rotation: 0 as const, nodeCounts: { small: 69, large: 758 }, selectors: { small: "page", large: "page" },
      helperSha256: h.config.helper.sha256, appSha256: h.config.sample.sha256, bootId: h.baseline.bootId };
    h.platform.ports.prepare = async () => ({ processReadyMs: now, helperPid: 100 });
    h.platform.ports.identity = async () => identity;
    h.platform.ports.session = async chunk => {
      session = new DebugSession({ serial: h.config.serial, packageName: h.config.packageName, directory: chunk.directory,
        snapshotPath: join(chunk.directory, "current.json"), onEvent: () => {}, observe: async () => { observations++; throw Error("must not observe"); } });
      session.state.expiresAt = new Date(Date.now() - 1).toISOString(); return session;
    };
    const r = await runCaptureControlEntry(h.config, h.platform, { offlineOnly: true,
      study: options => runCaptureControlStudy({ ...options, clock: { now: () => now, sleep: async ms => { now += ms; } } }) });
    assert.equal(r.failure?.code, "grant_expired"); assert.equal(observations, 0); assert.equal(session?.state.active, false);
    const study = readControlJson(r.studyPath); assert.equal(study.stages[0].blocks[0].result.failureCode, "grant_expired");
    assert.equal(study.stages[0].sessions[0].closed, true); assert(existsSync(study.stages[0].sessions[0].reportPath));
    assert.deepEqual(study.stages[0].counts, { attempts: 0, complete: 0 });
  } finally { session?.stop(); await session?.settled(); h.dispose(); }
});
for (const step of ["sessions", "packages", "pairing", "settings", "forwards", "dispose"]) test(`recovery failure at ${step} preserves primary disconnect and attempts later steps`, async () => {
  const h = entryFixture(); try {
    h.faults.set("study", new ControlEntryFault("transport_disconnected")); h.faults.set(step, new ControlEntryFault("recovery_injected"));
    const r = await runCaptureControlEntry(h.config, h.platform, { offlineOnly: true, study: h.syntheticStudy });
    assert.equal(r.status, "failed"); assert.equal(r.failure?.code, "transport_disconnected"); assert.equal(r.recoveryPassed, false);
    assert.deepEqual(h.events.slice(2), recoveryOrder);
    assert(readControlJson(r.recoveryPath!).steps.some((s: { status: string }) => s.status === "failed"));
  } finally { h.dispose(); }
});
test("preflight disconnect performs no package/pairing restoration without a trusted baseline", async () => {
  const h = entryFixture(); try {
    h.faults.set("preflight", new ControlEntryFault("transport_disconnected"));
    const r = await runCaptureControlEntry(h.config, h.platform, { offlineOnly: true, study: h.syntheticStudy });
    assert.equal(r.failure?.code, "transport_disconnected"); assert.deepEqual(h.events, ["preflight", "sessions", "dispose"]);
    assert(r.recoverySummary!.steps.slice(1, -1).every(s => s.status === "not_needed"));
  } finally { h.dispose(); }
});
test("caller cancellation cannot cancel independent recovery", async () => {
  const h = entryFixture(), controller = new AbortController();
  try {
    const r = await runCaptureControlEntry(h.config, h.platform, { offlineOnly: true, signal: controller.signal,
      study: async () => { controller.abort(); throw new ControlEntryFault("cancelled"); } });
    assert.equal(r.status, "cancelled"); assert(r.recoveryPassed); assert.deepEqual(h.events, ["preflight", ...recoveryOrder]);
  } finally { h.dispose(); }
});
test("unwritable recovery path cannot skip cleanup, and missing archives cannot pass", async () => {
  const h = entryFixture(); try {
    const r = await runCaptureControlEntry(h.config, h.platform, { offlineOnly: true,
      study: async () => { writeFileSync(join(h.config.runDirectory, "recovery"), "blocked directory", { flag: "wx" }); throw new ControlEntryFault("transport_disconnected"); } });
    assert.equal(r.failure?.code, "transport_disconnected"); assert.equal(r.recoveryPassed, false);
    assert.deepEqual(h.events, ["preflight", ...recoveryOrder]); assert(r.recoverySummary!.archiveErrors.length);
    assert(readControlJson(join(h.config.runDirectory, "entry.json")).recoverySummary.steps.length === 6);
  } finally { h.dispose(); }
});
test("changed main index gets an independent failure record without overwriting foreign bytes", async () => {
  const h = entryFixture(); try {
    const r = await runCaptureControlEntry(h.config, h.platform, { offlineOnly: true,
      study: async () => { writeFileSync(join(h.config.runDirectory, "entry.json"), "foreign bytes"); throw new ControlEntryFault("transport_disconnected"); } });
    assert.equal(r.status, "failed"); assert.equal(readFileSync(join(h.config.runDirectory, "entry.json"), "utf8"), "foreign bytes");
    const fallback = readdirSync(h.config.runDirectory).find(f => f.startsWith("entry-failure-"))!;
    const saved = readControlJson(join(h.config.runDirectory, fallback)); assert.equal(saved.failure.code, "transport_disconnected");
    assert.equal(saved.archiveFailure, "entry_index_write_failed"); assert(existsSync(saved.recoveryPath));
    const hash = entrySha(readFileSync(join(h.config.runDirectory, fallback))); h.events.length = 0;
    assert.equal((await recoverCaptureControlEntry(h.config, h.platform, join(h.config.runDirectory, fallback))).status, "passed");
    assert.deepEqual(h.events, recoveryOrder); assert.equal(entrySha(readFileSync(join(h.config.runDirectory, fallback))), hash);
    await assert.rejects(recoverCaptureControlEntry(h.config, h.platform, join(h.directory, "outside.json")), /outside/);
  } finally { h.dispose(); }
});
test("recovery-only creates a new attempt without changing old indexes or invoking study/preflight", async () => {
  const h = entryFixture(); try {
    h.faults.set("pairing", new ControlEntryFault("pairing_required"));
    const first = await runCaptureControlEntry(h.config, h.platform, { offlineOnly: true, study: h.syntheticStudy });
    const path = join(h.config.runDirectory, "entry.json"), original = entrySha(readFileSync(path));
    h.faults.clear(); h.events.length = 0;
    const recovery = await recoverCaptureControlEntry(h.config, h.platform);
    assert.equal(recovery.status, "passed"); assert.deepEqual(h.events, recoveryOrder);
    assert.equal(entrySha(readFileSync(path)), original); assert.notEqual(join(recovery.directory, "manifest.json"), first.recoveryPath);
    assert.equal(readdirSync(join(h.config.runDirectory, "recovery")).length, 2);
    await assert.rejects(recoverCaptureControlEntry({ ...h.config, helper: { ...h.config.helper, sha256: "b".repeat(64) } }, h.platform));
    assert.equal(h.events.length, 6);
  } finally { h.dispose(); }
});
test("recovery-only rejects active entries and a modified scope before platform calls", async () => {
  const h = entryFixture(); try {
    mkdirSync(h.config.runDirectory);
    writeFileSync(join(h.config.runDirectory, "entry.json"), JSON.stringify({ version: 1, fingerprint: controlFingerprint(h.config),
      status: "running", ownerPid: process.pid, baseline: h.baseline }));
    await assert.rejects(recoverCaptureControlEntry(h.config, h.platform), /still running/); assert.deepEqual(h.events, []);
  } finally { h.dispose(); }
});
test("journal rejects duplicate IDs and tampering while retaining original contents", () => {
  const h = entryFixture(); try {
    const path = join(h.directory, "journal.json"), save = createControlJournal(path, { status: "running" });
    assert.throws(() => createControlJournal(path, {}), /EEXIST/); save({ status: "failed" });
    writeFileSync(path, '{"foreign":true}'); assert.throws(() => save({ status: "passed" }));
    assert.deepEqual(readControlJson(path), { foreign: true });
  } finally { h.dispose(); }
});
test("replaced step archive stays untouched, marks recovery failed and retains later steps", async () => {
  const h = entryFixture(); try {
    h.faults.set("study", new ControlEntryFault("transport_disconnected"));
    let replaced = "";
    h.platform.restorePackages = async () => {
      h.events.push("packages"); const attempt = readdirSync(join(h.config.runDirectory, "recovery"))[0];
      replaced = join(h.config.runDirectory, "recovery", attempt, "2-packages.json"); writeFileSync(replaced, "foreign step bytes");
    };
    const r = await runCaptureControlEntry(h.config, h.platform, { offlineOnly: true, study: h.syntheticStudy });
    assert.equal(r.failure?.code, "transport_disconnected"); assert.equal(r.recoveryPassed, false);
    assert.equal(readFileSync(replaced, "utf8"), "foreign step bytes"); assert.deepEqual(h.events.slice(2), recoveryOrder);
    assert.equal(r.recoverySummary!.steps[1].archiveError, "step_archive_finish_failed");
  } finally { h.dispose(); }
});
test("total archive loss throws an explicit archive fault carrying primary and recovery evidence", async () => {
  const h = entryFixture(); try {
    h.faults.set("study", new ControlEntryFault("transport_disconnected"));
    h.platform.dispose = async () => { h.events.push("dispose"); renameSync(h.config.runDirectory, h.config.runDirectory + "-relocated"); };
    await assert.rejects(runCaptureControlEntry(h.config, h.platform, { offlineOnly: true, study: h.syntheticStudy }), error => {
      const e = error as ControlEntryFault & { primary: { code: string }; recovery: { status: string } };
      assert.equal(e.code, "failure_archive_unavailable"); assert.equal(e.primary.code, "transport_disconnected"); assert.equal(e.recovery.status, "failed"); return true;
    });
    assert.deepEqual(h.events.slice(2), recoveryOrder);
  } finally { h.dispose(); }
});
test("every recovery operation receives a fresh non-aborted signal after grant expiration", async () => {
  const h = entryFixture(), controller = new AbortController();
  try {
    h.platform.closeSessions = async signal => { assert(!signal.aborted); h.events.push("sessions"); };
    for (const name of ["restorePackages", "restorePairing", "verifySettings", "verifyForwards"] as const) h.platform[name] = async (_baseline, signal) => { assert(!signal.aborted); h.events.push(name); };
    const result = await runCaptureControlEntry(h.config, h.platform, { offlineOnly: true, signal: controller.signal,
      study: async () => { controller.abort(); throw new ControlEntryFault("grant_expired"); } });
    assert.equal(result.failure?.code, "grant_expired"); assert(result.recoveryPassed); assert.equal(result.recoverySummary!.steps.length, 6);
  } finally { h.dispose(); }
});
