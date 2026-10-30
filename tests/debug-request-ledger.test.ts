import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DebugRequestLedger, MAX_DEBUG_REQUEST_LEDGER_BYTES, MAX_DEBUG_REQUEST_RECORDS } from "../electron/automation/debug-request-ledger";

const input = () => ({ action: { kind: "tap" }, target: { selector: { text: "我", clickable: true } }, timeoutMs: 20000 });
function fixture(options: { maxRecords?: number; maxBytes?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "inspector-request-ledger-"));
  const create = () => new DebugRequestLedger({ sessionDirectory: directory, sessionId: "session-one", ...options });
  return { directory, create, ledger: create(), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("one ID is reserved once across concurrent callbacks and results are already on disk", async () => {
  const f = fixture(), id = randomUUID();
  try {
    const requests = await Promise.all(Array.from({ length: 12 }, async () => f.ledger.reserve(id, input())));
    assert.equal(requests.filter(result => result.created).length, 1);
    assert.ok(requests.every(result => result.record.requestId === id));
    const stored = JSON.parse(readFileSync(f.ledger.path, "utf8"));
    assert.equal(stored.sessionId, "session-one");
    assert.equal(stored.records.length, 1);
    assert.equal(stored.records[0].state, "running");
    assert.equal(stored.records[0].dispatchState, "not_sent");
  } finally { f.cleanup(); }
});

test("canonical hashes sort nested keys, preserve arrays and include timeout and every semantic value", () => {
  const f = fixture(), id = randomUUID();
  try {
    const first = { ...input(), conditions: [{ text: "A", enabled: true }, { text: "B" }], optional: undefined };
    f.ledger.reserve(id, first);
    const reordered = { conditions: [{ enabled: true, text: "A" }, { text: "B" }], timeoutMs: 20000,
      target: { selector: { clickable: true, text: "我" } }, action: { kind: "tap" } };
    assert.equal(f.ledger.reserve(id.toUpperCase(), reordered).created, false);
    for (const different of [{ ...reordered, timeoutMs: 20001 }, { ...reordered, conditions: [...reordered.conditions].reverse() },
      { ...reordered, action: { kind: "back" } }, { ...reordered, target: { selector: { text: "你", clickable: true } } }])
      assert.throws(() => f.ledger.reserve(id, different), /参数不同/);
    assert.equal(JSON.parse(readFileSync(f.ledger.path, "utf8")).records.length, 1);
  } finally { f.cleanup(); }
});

test("disk refresh prevents a second ledger instance with stale memory from reserving the same ID", () => {
  const f = fixture(), id = randomUUID();
  try {
    const second = f.create();
    f.ledger.reserve(id, input());
    assert.equal(second.reserve(id, input()).created, false);
    assert.throws(() => second.reserve(id, { ...input(), timeoutMs: 1 }), /参数不同/);
  } finally { f.cleanup(); }
});

test("legacy requests replay the newly explicit UIAutomator default without changing stored identity", () => {
  const f = fixture(), id = randomUUID();
  try {
    const old = f.ledger.reserve(id, input()).record;
    const replay = f.ledger.reserve(id, { ...input(), backend: "uiautomator" });
    assert.equal(replay.created, false);
    assert.equal(replay.record.fingerprint, old.fingerprint);
    assert.equal(replay.record.input.backend, undefined);
    assert.throws(() => f.ledger.reserve(id, { ...input(), backend: "accessibility-helper" }), /参数不同/);
    assert.throws(() => f.ledger.reserve(id, { ...input(), backend: "uiautomator", timeoutMs: 1 }), /参数不同/);
    const reloaded = f.create();
    assert.equal(reloaded.reserve(id, { ...input(), backend: "uiautomator" }).created, false);
  } finally { f.cleanup(); }
});

test("reload interrupts unfinished requests and never resets sent or unknown to an executable request", () => {
  const f = fixture(), notSent = randomUUID(), unknown = randomUUID(), sent = randomUUID(), completed = randomUUID();
  try {
    for (const id of [notSent, unknown, sent, completed]) f.ledger.reserve(id, input());
    f.ledger.markDispatch(unknown, "unknown", 1);
    f.ledger.markDispatch(sent, "unknown", 2);
    f.ledger.markDispatch(sent, "sent", 2);
    f.ledger.markDispatch(completed, "sent", 3);
    f.ledger.finish(completed, { verified: true, snapshotId: "snapshot-one" });
    const reopened = f.create();
    for (const id of [notSent, unknown, sent]) {
      const duplicate = reopened.reserve(id, input());
      assert.equal(duplicate.created, false);
      assert.equal(duplicate.record.state, "interrupted");
      assert.equal(duplicate.record.dispatchState, id === notSent ? "not_sent" : "unknown");
      assert.throws(() => reopened.markDispatch(id, "unknown"), /不能重新发送/);
    }
    assert.equal(reopened.get(sent)!.stepId, 2);
    assert.equal(reopened.get(completed)!.state, "completed");
    assert.equal(reopened.get(completed)!.dispatchState, "sent");
    assert.deepEqual(reopened.get(completed)!.result, { verified: true, snapshotId: "snapshot-one" });
    reopened.finish(sent, { verified: true, snapshotId: "observation-only" });
    assert.equal(reopened.get(sent)!.state, "completed");
    assert.equal(reopened.get(sent)!.dispatchState, "unknown");
    assert.throws(() => reopened.markDispatch(sent, "sent"), /不能重新发送/);
  } finally { f.cleanup(); }
});

test("input, reserve, get and result objects are all isolated deep copies", () => {
  const f = fixture(), id = randomUUID();
  try {
    const original = input();
    const reserved = f.ledger.reserve(id, original);
    original.target.selector.text = "changed";
    (reserved.record.input.target as ReturnType<typeof input>["target"]).selector.text = "changed again";
    const read = f.ledger.get(id)!;
    (read.input.target as ReturnType<typeof input>["target"]).selector.text = "third change";
    const result = { evidence: { snapshotId: "one", observations: ["one", "two"] } };
    const finished = f.ledger.finish(id, result);
    result.evidence.observations.push("three");
    (finished.result!.evidence as typeof result.evidence).snapshotId = "changed";
    assert.deepEqual(f.ledger.get(id)!.input, input());
    assert.deepEqual(f.ledger.get(id)!.result, { evidence: { snapshotId: "one", observations: ["one", "two"] } });
  } finally { f.cleanup(); }
});

test("full ledger rejects new IDs without evicting running or completed deduplication records", () => {
  const f = fixture({ maxRecords: 2 }), ids = [randomUUID(), randomUUID(), randomUUID()];
  try {
    f.ledger.reserve(ids[0], input());
    f.ledger.finish(ids[0], { verified: true });
    f.ledger.reserve(ids[1], input());
    assert.throws(() => f.ledger.reserve(ids[2], input()), /已满/);
    assert.equal(f.ledger.reserve(ids[0], input()).created, false);
    assert.equal(f.ledger.reserve(ids[1], input()).created, false);
    assert.equal(f.ledger.get(ids[2]), undefined);
    assert.equal(JSON.parse(readFileSync(f.ledger.path, "utf8")).records.length, 2);
  } finally { f.cleanup(); }
});

test("size limit rejects writes before changing durable or in-memory state", () => {
  const f = fixture({ maxBytes: 1024 }), id = randomUUID();
  try {
    const before = readFileSync(f.ledger.path, "utf8");
    assert.throws(() => f.ledger.reserve(id, { text: "x".repeat(1024) }), /容量上限/);
    assert.equal(readFileSync(f.ledger.path, "utf8"), before);
    assert.equal(f.ledger.get(id), undefined);
    assert.equal(f.ledger.reserve(id, input()).created, true);
    assert.throws(() => f.ledger.finish(id, { text: "x".repeat(1024) }), /容量上限/);
    assert.equal(f.ledger.get(id)!.state, "running");
    writeFileSync(f.ledger.path, " ".repeat(1025));
    assert.throws(() => f.create(), /容量上限/);
  } finally { f.cleanup(); }
});

test("permission failure cannot reserve or advance dispatch and does not lose previous records", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const f = fixture(), first = randomUUID(), second = randomUUID();
  try {
    f.ledger.reserve(first, input());
    const before = readFileSync(f.ledger.path, "utf8");
    chmodSync(f.directory, 0o500);
    assert.throws(() => f.ledger.reserve(second, input()));
    assert.throws(() => f.ledger.markDispatch(first, "unknown", 1));
    assert.equal(readFileSync(f.ledger.path, "utf8"), before);
    chmodSync(f.directory, 0o700);
    assert.equal(f.ledger.get(first)!.dispatchState, "not_sent");
    assert.equal(f.ledger.reserve(second, input()).created, true);
  } finally { chmodSync(f.directory, 0o700); f.cleanup(); }
});

test("corruption, unknown fields, mismatched sessions and duplicate IDs fail closed", () => {
  const f = fixture(), id = randomUUID();
  try {
    f.ledger.reserve(id, input());
    const original = readFileSync(f.ledger.path, "utf8");
    const corruptions: Array<(value: any) => void> = [
      value => { value.sessionId = "another-session"; },
      value => { value.format = "future-version"; },
      value => { value.extra = true; },
      value => { value.records[0].extra = true; },
      value => { value.records[0].fingerprint = "f".repeat(64); },
      value => { value.records[0].input.timeoutMs = 999; },
      value => { value.records.push(value.records[0]); },
      value => { value.records[0].state = "completed"; },
      value => { value.records[0].dispatchState = "pending"; },
      value => { value.records[0].stepId = -1; },
      value => { value.records[0].createdAt = "invalid"; },
    ];
    for (const corrupt of corruptions) {
      const value = JSON.parse(original); corrupt(value);
      writeFileSync(f.ledger.path, JSON.stringify(value));
      assert.throws(() => f.create());
      assert.throws(() => f.ledger.reserve(randomUUID(), input()));
      assert.equal(existsSync(`${f.ledger.path}.lock`), false);
    }
    writeFileSync(f.ledger.path, "{broken");
    assert.throws(() => f.create());
    assert.throws(() => f.ledger.get(id));
  } finally { f.cleanup(); }
});

test("missing ledger after initialization and a leftover lock never recreate an empty ledger", () => {
  const f = fixture(), id = randomUUID();
  try {
    f.ledger.reserve(id, input());
    mkdirSync(`${f.ledger.path}.lock`);
    assert.throws(() => f.ledger.get(id));
    assert.throws(() => f.create());
    rmSync(`${f.ledger.path}.lock`, { recursive: true });
    rmSync(f.ledger.path);
    assert.throws(() => f.ledger.reserve(id, input()));
    assert.equal(existsSync(f.ledger.path), false);
  } finally { f.cleanup(); }
});

test("private file modes and symbolic link refusal protect local request contents", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    f.ledger.reserve(randomUUID(), input());
    assert.equal(statSync(f.directory).mode & 0o777, 0o700);
    assert.equal(statSync(f.ledger.path).mode & 0o777, 0o600);
    const other = join(f.directory, "other.json");
    writeFileSync(other, readFileSync(f.ledger.path));
    rmSync(f.ledger.path);
    symlinkSync(other, f.ledger.path);
    assert.throws(() => f.create());
    assert.throws(() => f.ledger.reserve(randomUUID(), input()));
  } finally { f.cleanup(); }
});

test("invalid JSON, IDs and out-of-range configuration are rejected without recording", () => {
  const f = fixture();
  try {
    const circular: Record<string, unknown> = {}; circular.self = circular;
    for (const value of [circular, { value: NaN }, { value: Infinity }, { value: 1n }, { value: new Date() }, { value: [undefined] }])
      assert.throws(() => f.ledger.reserve(randomUUID(), value));
    assert.throws(() => f.ledger.reserve("not-an-id", input()));
    assert.throws(() => f.ledger.markDispatch(randomUUID(), "unknown"), /不存在/);
    assert.throws(() => f.ledger.finish(randomUUID(), {}), /不存在/);
    assert.equal(f.ledger.get(randomUUID()), undefined);
    for (const options of [{ maxRecords: 0 }, { maxRecords: MAX_DEBUG_REQUEST_RECORDS + 1 },
      { maxBytes: MAX_DEBUG_REQUEST_LEDGER_BYTES + 1 }, { maxBytes: 0.5 }])
      assert.throws(() => new DebugRequestLedger({ sessionDirectory: f.directory, sessionId: "session-one", ...options }));
    assert.equal(JSON.parse(readFileSync(f.ledger.path, "utf8")).records.length, 0);
  } finally { f.cleanup(); }
});

test("sent dispatch is monotonic and input step IDs cannot be reassigned", () => {
  const f = fixture(), id = randomUUID();
  try {
    f.ledger.reserve(id, input());
    f.ledger.markDispatch(id, "unknown", 1);
    f.ledger.markDispatch(id, "not_sent", 1);
    f.ledger.markDispatch(id, "unknown", 1);
    f.ledger.markDispatch(id, "sent", 1);
    for (const state of ["not_sent", "unknown"] as const) assert.throws(() => f.ledger.markDispatch(id, state), /不能回退/);
    assert.throws(() => f.ledger.markDispatch(id, "sent", 2), /另一个输入步骤/);
    assert.equal(f.ledger.get(id)!.dispatchState, "sent");
    assert.equal(f.ledger.get(id)!.stepId, 1);
    f.ledger.finish(id, { verified: false });
    assert.throws(() => f.ledger.markDispatch(id, "sent", 1), /不能重新发送/);
  } finally { f.cleanup(); }
});
