import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { UiSnapshot } from "../shared/types";

/** No pixels in the report; exact encoded-image equality is not RGBA acceptance. */
export function staticCaptureSummary(snapshot: UiSnapshot) {
  assert.equal(snapshot.error, null, snapshot.error ?? "capture failed");
  assert.ok(snapshot.root);
  assert.equal(snapshot.captureRequestDiagnostics?.totalAttempts, 1, "no retry samples");
  const attributes = snapshot.root.attributes ?? {};
  assert.equal(attributes["sdk-tree-source"], "merged", "same production route required");
  for (const key of ["sdk-first-fallback", "sdk-visible-fallback", "sdk-ref-fallback"])
    assert.ok(!attributes[key], "fallback samples cannot qualify as matched SDK captures");
  const entries = [];
  const pending = [snapshot.root];
  let images = 0, bytes = 0;
  while (pending.length) {
    const node = pending.pop()!;
    assert.notEqual(node.layerImageStatus, "failed", "failed layer must stop comparison");
    let digest: string | null = null;
    if (node.layerImageDataUrl) {
      const match = /^data:image\/[\w.+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(node.layerImageDataUrl);
      assert.ok(match, "invalid encoded image");
      const data = Buffer.from(match[1], "base64");
      digest = createHash("sha256").update(data).digest("hex");
      images++; bytes += data.length;
    }
    entries.push({ id: node.id, ref: node.attributes?.["view-ref"] ?? null, className: node.className,
      bounds: node.bounds, imageSize: node.layerImageSize ?? null, placement: node.layerCapturePlacement ?? null,
      status: node.layerImageStatus ?? null, empty: node.layerImageEmpty ?? null,
      visible: node.visibleToUser, children: node.children.map(child => child.id), digest });
    pending.push(...node.children);
  }
  assert.equal(entries.length, snapshot.nodeCount);
  assert.ok(entries.length <= 5000, "bounded tree required");
  assert.ok(images >= 400, "fixed large-tree coverage required");
  const identity = { pid: attributes["debug-process-id"], instance: attributes["sdk-process-instance"],
    root: snapshot.root.children[0]?.attributes?.["view-ref"], window: attributes["debug-window-name"] };
  assert.ok(identity.pid && identity.instance && identity.root && identity.window, "complete identity required");
  return { identity, nodes: entries.length, images, bytes,
    fingerprint: createHash("sha256").update(JSON.stringify(entries)).digest("hex") };
}

export function assertStaticWorkload(reference: ReturnType<typeof staticCaptureSummary>, actual: ReturnType<typeof staticCaptureSummary>) {
  assert.deepEqual(actual.identity, reference.identity, "process/window changed");
  assert.equal(actual.nodes, reference.nodes, "tree workload changed");
  assert.equal(actual.images, reference.images, "image coverage changed");
  assert.equal(actual.bytes, reference.bytes, "encoded workload changed");
  assert.equal(actual.fingerprint, reference.fingerprint, "geometry, statuses or encoded pixels changed");
}
