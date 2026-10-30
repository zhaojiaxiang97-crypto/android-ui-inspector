import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMethodProfile } from "../scripts/diagnostics/sdk/sdk-method-profile";

type Event = [number, number, number, number];
const events: Event[] = [[42, 0, 0, 0], [42, 4, 10, 10], [42, 8, 20, 20], [42, 9, 50, 60], [42, 5, 70, 80],
  [43, 4, 0, 0], [43, 5, 10, 20], [44, 4, 0, 0], [44, 5, 20, 30]];
function fixture(rows = events) {
  const text = `*version\n3\ndata-file-overflow=false\nclock=dual\npid=42\nnum-method-calls=${rows.length}\n*threads\n42\tmain\n43\tinspector-encode\n44\tinspector-encode\n*methods\n0\tRoot\tmain\t()V\n0x4\tcom.androiduiinspector.sdk.Capture\trun\t()V\n0x8\torg.json.JSONStringer\tstring\t()V\n*end\n`;
  const bytes = Buffer.alloc(32 + rows.length * 14);
  bytes.writeUInt32LE(0x574f4c53); bytes.writeUInt16LE(3, 4); bytes.writeUInt16LE(32, 6); bytes.writeUInt16LE(14, 16);
  rows.forEach(([tid, action, cpu, wall], index) => {
    const at = 32 + index * 14;
    bytes.writeUInt16LE(tid, at); bytes.writeUInt32LE(action, at + 2); bytes.writeUInt32LE(cpu, at + 6); bytes.writeUInt32LE(wall, at + 10);
  });
  return Buffer.concat([Buffer.from(text), bytes]);
}
test("ART dual-clock samples attribute CPU to previous leaf, not elapsed wall time", () => {
  const report = parseMethodProfile(fixture(), "42");
  assert.equal(report.approximate, true);
  assert.equal(report.records, events.length);
  assert.equal(report.threads[0]!.cpuUs, 70);
  assert.equal(report.threads[0]!.observedWallUs, 80);
  assert.equal(report.threads[0]!.observedCpuUs, 70);
  assert.equal(report.threads[0]!.nonCpuUs, 10);
  assert.deepEqual(report.threads[0]!.self.map(row => [row.method, row.cpuUs]), [
    ["com.androiduiinspector.sdk.Capture.run()V", 30], ["org.json.JSONStringer.string()V", 30], ["Root.main()V", 10]]);
  assert.equal(report.threads[0]!.sdkInclusive[0]!.cpuUs, 60);
  assert.equal(report.threads[0]!.jsonInclusive[0]!.cpuUs, 30);
  assert.equal(report.threads[1]!.cpuUs, 10);
  const waiting = report.threads[0]!.waitingStacks;
  assert.equal(waiting.reduce((sum, row) => sum + row.nonCpuUs, 0), 10);
  assert.equal(waiting[0]!.stack.at(-1), "org.json.JSONStringer.string()V");
  assert.equal(waiting[0]!.wallUs, 40); assert.equal(waiting[0]!.cpuUs, 30);
});

test("sampled waiting stack retains native entry without claiming native frames or exact lock time", () => {
  const rows: Event[] = [[42, 0, 0, 0], [42, 4, 10, 10], [42, 8, 20, 20],
    [42, 9, 30, 1020], [42, 5, 40, 1030], [43, 4, 0, 0], [43, 5, 10, 20], [44, 4, 0, 0], [44, 5, 20, 30]];
  const bytes = Buffer.from(fixture(rows).toString("latin1").replace("org.json.JSONStringer\tstring\t()V", "android.graphics.HardwareRenderer\tnCreateHardwareBitmap\t()V"), "latin1");
  const result = parseMethodProfile(bytes, "42");
  const stack = result.threads[0]!.waitingStacks[0]!;
  assert.equal(stack.nonCpuUs, 990); assert.equal(stack.intervals, 1);
  assert.equal(stack.stack.at(-1), "android.graphics.HardwareRenderer.nCreateHardwareBitmap()V");
  assert.equal(result.approximate, true);
});
test("rejects process mismatch, overflow, unsupported format and missing encoders", () => {
  const trace = fixture();
  assert.throws(() => parseMethodProfile(trace, "41"));
  for (const [a, b] of [["overflow=false", "overflow=true"], ["clock=dual", "clock=wall"],
    ["*version\n3", "*version\n2"], ["44\tinspector-encode", "44\tother"]]) {
    assert.throws(() => parseMethodProfile(Buffer.from(trace.toString("latin1").replace(a!, b!), "latin1"), "42"));
  }
});
test("rejects partial/unknown records, stack mismatch and backward clocks", () => {
  assert.throws(() => parseMethodProfile(fixture().subarray(0, -1), "42"));
  assert.throws(() => parseMethodProfile(fixture([[42, 12, 0, 0]]), "42"));
  assert.throws(() => parseMethodProfile(fixture([[42, 3, 0, 0]]), "42"));
  assert.throws(() => parseMethodProfile(fixture([[42, 0, 0, 0], [42, 5, 1, 1]]), "42"));
  assert.throws(() => parseMethodProfile(fixture([[42, 0, 10, 10], [42, 4, 9, 11]]), "42"));
});
test("rejects trace TID collisions and record-count mismatch", () => {
  const trace = fixture().toString("latin1");
  assert.throws(() => parseMethodProfile(Buffer.from(trace.replace("*methods\n", "65578\tother\n*methods\n"), "latin1"), "42"));
  assert.throws(() => parseMethodProfile(Buffer.from(trace.replace(`num-method-calls=${events.length}`, "num-method-calls=1"), "latin1"), "42"));
});

test("thread dictionary alone is not evidence of observed encoder CPU", () => {
  assert.throws(() => parseMethodProfile(fixture(events.filter(([tid]) => tid === 42)), "42"));
});

test("sample-only encoder role must be explicit and still have two observed threads", () => {
  const trace = Buffer.from(fixture().toString("latin1").replace(/inspector-encode/g, "geometry-encode"), "latin1");
  assert.throws(() => parseMethodProfile(trace, "42"));
  const result = parseMethodProfile(trace, "42", "geometry-encode");
  assert.equal(result.threads.filter(thread => thread.name === "geometry-encode").length, 2);
  assert.throws(() => parseMethodProfile(trace, "42", "main"));
  assert.throws(() => parseMethodProfile(Buffer.from(trace.toString("latin1").replace("44\tgeometry-encode", "44\tother"), "latin1"), "42", "geometry-encode"));
});
