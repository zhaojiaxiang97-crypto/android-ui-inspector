import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { visualCaptureFixture } from "../electron/desktop/visual-capture-fixture";
import type { UiSnapshot } from "../shared/types";

function fixture(): UiSnapshot {
  const root = makeNode("0"); root.children = [makeNode("0/0"), makeNode("0/1")];
  return { serial: "fixture", root, nodeCount: 3, xmlSize: 0, rawXml: null, screenshotDataUrl: null, error: null, warning: null };
}
test("development lifecycle publishes cloned tree then synthetic captured/empty pixels", async () => {
  const input = fixture(), events: any[] = [];
  const result = await visualCaptureFixture(input, "recovery", { solid: "fixture-solid", empty: "fixture-empty" }, {
    signal: AbortSignal.timeout(5000), onProgress: () => {}, onPreview: (phase, snapshot) => events.push({ phase, snapshot }) });
  assert.deepEqual(events.map(event => event.phase), ["tree", "layers"]);
  assert.equal(events[0].snapshot.root.children[0].layerImageDataUrl, undefined, "tree IPC snapshot must not mutate later");
  assert.equal(result.root!.children[0].layerImageStatus, "captured");
  assert.equal(result.root!.children[1].layerImageEmpty, true);
  assert.match(result.root!.children[0].attributes!["image-source"], /测试夹具/);
  assert.equal(input.root!.children[0].layerImageDataUrl, undefined);
});
test("cancel fixture attempts late callbacks for desktop rejection and retains cancellation reason", async () => {
  const controller = new AbortController(), reason = new Error("fixture-user-cancel"), stages: string[] = [], phases: string[] = [];
  await assert.rejects(visualCaptureFixture(fixture(), "cancelled", { solid: "solid", empty: "empty" }, {
    signal: controller.signal, onProgress: stage => stages.push(stage), onPreview: phase => {
      phases.push(phase); if (phase === "layers" && !controller.signal.aborted) controller.abort(reason);
    } }), error => error === reason);
  assert.deepEqual(phases, ["tree", "layers", "layers"]);
  assert.ok(stages.some(stage => stage.includes("迟到")));
  assert.ok(!stages.some(stage => stage.includes("完成")));
});
