import { createHash } from "node:crypto";
import type { UiSnapshot } from "../shared/types";

/** Cross-route IDs can differ. Compare View refs, never row IDs or image count alone. */
export function smallPageRouteSummary(snapshot: UiSnapshot) {
  const nodes = [];
  const refs = new Set<string>();
  const pending = snapshot.root ? [snapshot.root] : [];
  while (pending.length) {
    const node = pending.pop()!;
    const ref = node.attributes?.["view-ref"];
    if (ref && refs.has(ref)) throw new Error("duplicate View ref in route snapshot");
    if (ref) { refs.add(ref); nodes.push({ ref, className: node.className, bounds: node.bounds ? { ...node.bounds } : node.bounds, visible: node.visibleToUser,
      status: node.layerImageStatus ?? null, empty: node.layerImageEmpty ?? null,
      size: node.layerImageSize ? { ...node.layerImageSize } : null, source: node.attributes?.["image-source"] ?? null,
      failure: node.attributes?.["image-capture-error"] ?? null,
      encodedSha: node.layerImageDataUrl ? createHash("sha256").update(node.layerImageDataUrl).digest("hex") : null }); }
    pending.push(...node.children);
  }
  nodes.sort((a, b) => a.ref.localeCompare(b.ref));
  return { error: snapshot.error, warning: snapshot.warning ?? null, nodeCount: snapshot.nodeCount,
    attempts: snapshot.captureRequestDiagnostics, timings: snapshot.captureTimings,
    attributes: snapshot.root?.attributes, nodes };
}

export function compareSmallPageRoutes(before: ReturnType<typeof smallPageRouteSummary>, after: ReturnType<typeof smallPageRouteSummary>) {
  const first = new Map(before.nodes.map(node => [node.ref, node]));
  const second = new Map(after.nodes.map(node => [node.ref, node]));
  const differences = [];
  for (const ref of new Set([...first.keys(), ...second.keys()])) {
    const a = first.get(ref), b = second.get(ref);
    if (!a || !b) { differences.push({ ref, kind: "missing-node" }); continue; }
    if (a.className !== b.className || JSON.stringify(a.bounds) !== JSON.stringify(b.bounds) || a.visible !== b.visible)
      differences.push({ ref, kind: "geometry-or-type" });
    if (JSON.stringify(a.size) !== JSON.stringify(b.size)) differences.push({ ref, kind: "image-size" });
    if (Boolean(a.encodedSha) !== Boolean(b.encodedSha) || a.status !== b.status || a.empty !== b.empty)
      differences.push({ ref, kind: "coverage-or-status", before: a.status, after: b.status });
    if (a.encodedSha && b.encodedSha && a.encodedSha !== b.encodedSha)
      differences.push({ ref, kind: "encoded-image", before: a.source, after: b.source });
  }
  return { differences, encodedEqualityIsNotPixelAcceptance: true };
}
