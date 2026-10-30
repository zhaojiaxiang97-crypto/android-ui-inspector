import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { compareScrollProgress, inspectScrollTree, type ScrollObservation } from "../electron/automation/debug-scroll-execution";
import { parseUiHierarchy } from "../electron/capture/xml-tree";
import { scrollUntilInput } from "../shared/debug-protocol";
import { hasCompleteHelperObservationEvidence } from "../shared/helper-observation";
import { helperEvidenceSnapshot } from "./fixtures/helper-evidence";

const packageName = "com.example.helper", frame = { width: 200, height: 400, rotation: 0 as const };
const input = scrollUntilInput.parse({ sessionId: randomUUID(), requestId: randomUUID(), backend: "accessibility-helper",
  target: { selector: { resourceId: "list" } }, direction: "down", until: { selector: { text: "END" } } });
let sequence = 0;
function observation(top = 200, options: { duplicate?: boolean; extraTop?: number; viewportTop?: number; width?: number; text?: string; coveredText?: string } = {}): ScrollObservation {
  const snapshot = helperEvidenceSnapshot({ packageName, startedAt: ++sequence * 100, ...frame });
  const attrs = `package="${packageName}" content-desc="" window-id="7" visible-to-user="true" enabled="true" clickable="false" focusable="false" focused="false" selected="false"`;
  const row = (index: number, text: string, y: number, right = 180) => {
    const b = `[20,${y}][${right},${y + 30}]`;
    return `<node index="${index}" class="Text" resource-id="" text="${text}" ${attrs} bounds="${b}" bounds-screen="${b}" visible-bounds="${b}" scrollable="false"/>`;
  };
  const bounds = `[10,${options.viewportTop ?? 30}][190,370]`;
  const xml = `<hierarchy rotation="0"><node index="0" class="List" resource-id="list" text="" ${attrs} bounds="${bounds}"
    bounds-screen="${bounds}" visible-bounds="${bounds}" scrollable="true">${row(0, options.text ?? "anchor", top, options.width ?? 180)}
    ${row(1, options.duplicate ? "anchor" : options.coveredText ?? "covered", 80)}${options.extraTop === undefined ? "" : row(2, "second", options.extraTop)}</node></hierarchy>`;
  Object.assign(snapshot, { root: parseUiHierarchy(xml).root, rawXml: xml, xmlSize: Buffer.byteLength(xml), nodeCount: options.extraTop === undefined ? 3 : 4 });
  snapshot.helperObservation!.windowsBefore.push({ id: "8", type: "system", layer: 2, active: false, focused: false, rootAvailable: true,
    packageName: "com.android.systemui", bounds: { x: 170, y: 80, width: 30, height: 30 } });
  snapshot.helperObservation!.windowsAfter = structuredClone(snapshot.helperObservation!.windowsBefore);
  assert.equal(hasCompleteHelperObservationEvidence(snapshot), true);
  const current = { entry: { id: randomUUID(), sharedAt: new Date().toISOString(), ownerPid: 1, selectedNodeId: null, snapshot },
    target: { packageName, activityName: ".Main", component: packageName + "/.Main", windowId: "7", activityRecordId: "record" } };
  return { current, ...inspectScrollTree(snapshot, input, packageName, snapshot.root!, "7") };
}

test("a clear unique common anchor proves directional change despite another row being occluded", () => {
  const before = observation(), after = observation(180);
  assert.equal(before.progressKey, null); assert.equal(after.progressKey, null);
  assert.equal(compareScrollProgress(before, after, "down"), "changed");
  assert.equal(compareScrollProgress(observation(180), observation(200), "up"), "changed");
  assert.equal(before.condition, null); assert.equal(after.condition, null);
});

test("partial evidence never proves unchanged and rejects ambiguity, reverse motion, changed geometry and missing common anchors", () => {
  const before = observation();
  for (const after of [observation(), observation(199), observation(202), observation(220), observation(180, { width: 170 }),
    observation(180, { viewportTop: 31 })])
    assert.equal(compareScrollProgress(before, after, "down"), "unknown");
  assert.equal(compareScrollProgress(observation(200, { duplicate: true }), observation(180, { duplicate: true }), "down"), "unknown");
  assert.equal(compareScrollProgress(observation(200, { extraTop: 270 }), observation(180, { extraTop: 290 }), "down"), "unknown");
});

test("clear unique two-sided replacement proves content changed without a common anchor", () => {
  const before = observation(200, { text: "old", coveredText: "old-covered" });
  const after = observation(200, { text: "new", coveredText: "new-covered" });
  assert.equal(before.progressKey, null); assert.equal(after.progressKey, null);
  assert.equal(compareScrollProgress(before, after, "down"), "changed");
  assert.equal(after.condition, null, "content replacement is not an end assertion");
});

test("two-sided replacement rejects duplicate keys, one-sided changes, covered anchors and only clear-subset disappearance", () => {
  for (const [before, after] of [
    [observation(200, { text: "old", coveredText: "old" }), observation(200, { text: "new" })],
    [observation(200, { text: "old" }), observation(200, { text: "new", coveredText: "new" })],
    [observation(200, { text: "old" }), observation(200, { text: "new", coveredText: "old" })],
    [observation(200, { text: "old", coveredText: "new" }), observation(200, { text: "new" })],
    [observation(80, { text: "old" }), observation(200, { text: "new" })],
    [observation(200, { text: "old" }), observation(80, { text: "new" })],
    [observation(200, { text: "old" }), observation(200, { text: "new", viewportTop: 31 })],
  ]) assert.equal(compareScrollProgress(before, after, "down"), "unknown");
  const before = observation(200, { text: "old" }), foreign = observation(200, { text: "new" });
  foreign.current.target.activityRecordId = "other";
  assert.equal(compareScrollProgress(before, foreign, "down"), "unknown");
});
