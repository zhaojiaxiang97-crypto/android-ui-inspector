import assert from "node:assert/strict";
import type { smallPageRouteSummary } from "./small-page-route-summary";

export function recoveryRouteFlags(args: string[]) {
  assert.ok(args.length <= 2 && new Set(args).size === args.length
    && args.every(flag => ["--default-route", "--require-tree-ready"].includes(flag)), "invalid recovery route flags");
  const defaultRoute = args.includes("--default-route"), requireTreeReady = args.includes("--require-tree-ready");
  assert.ok(!(defaultRoute && requireTreeReady), "default route retains the classic tree, not a merged notification requirement");
  return { defaultRoute, requireTreeReady };
}

/** Default means the property is absent, not an explicit true or false. */
export function recoveryRouteOptions(defaultRoute: boolean): { preferVisibleSdk?: boolean } {
  return defaultRoute ? {} : { preferVisibleSdk: true };
}

export function assertDefaultSdkStages(stages: string[]) {
  assert.ok(stages.includes("SDK 抓取独立画面"), "default route did not select SDK images");
  assert.ok(!stages.some(stage => /DDMS.*抓图/.test(stage)), "default route performed DDMS image capture");
}

export function assertDefaultSdkResult(summary: ReturnType<typeof smallPageRouteSummary>, stages: string[]) {
  assertDefaultSdkStages(stages);
  assert.ok(summary.nodeCount > 0 && summary.nodeCount < 200, "default small-page acceptance requires fewer than 200 nodes");
  assert.equal(summary.attributes?.["sdk-visible-stream"], "2");
  assert.equal(summary.attributes?.["sdk-ui-wake-version"], "1");
  assert.ok(Number(summary.attributes?.["sdk-visible-images"]) > 0, "SDK image batch evidence missing");
  for (const key of ["ddms-batch-layers", "ddms-batch-images", "ddms-batch-bytes"])
    assert.equal(summary.attributes?.[key], undefined, `unexpected DDMS batch evidence: ${key}`);
  const images = summary.nodes.filter(node => node.encodedSha);
  assert.ok(images.length > 0);
  assert.ok(images.every(node => node.source?.includes("SDK") && !node.source.includes("DDMS")), "non-SDK image source");
}
