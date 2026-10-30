import type { UiSnapshot } from "./types";
import { hasCompleteHelperTree } from "./helper-observation";

/** Machine-readable distinctions for read-only clients; never grants action authority. */
export function inspectionProvenance(snapshot: UiSnapshot) {
  const source = snapshot.inspectionSource ?? "unknown";
  const helper = source === "accessibility-helper";
  const semantic = source === "uiautomator" || helper;
  const independentLayers = source.startsWith("debug-");
  return {
    treeSource: source,
    treeKind: semantic ? "accessibility-semantics" as const
      : independentLayers ? "debug-render-hierarchy" as const : "unknown" as const,
    completeness: helper ? hasCompleteHelperTree(snapshot) ? "helper-tree-verified" as const : "unverified" as const
      : snapshot.hierarchyDumpMode === "compressed" ? "filtered" as const : "not-established" as const,
    screenshotAvailable: Boolean(snapshot.screenshotDataUrl),
    screenshotRelation: helper && snapshot.helperObservation
      ? "ordered-after-tree-not-atomic" as const : "independent-not-atomic" as const,
    boundsKind: snapshot.captureGeometry ? "screen-geometry-with-capture-checks" as const : "unverified" as const,
    independentLayers: independentLayers && snapshot.layerCapture !== "on-demand"
      ? "possible-not-guaranteed" as const
      : independentLayers ? "deferred-on-demand" as const : "not-provided" as const,
    captureTime: "per-source-capture-metadata-or-unknown" as const,
    actionIdentity: "fresh-authorized-revalidation-required" as const,
  };
}
