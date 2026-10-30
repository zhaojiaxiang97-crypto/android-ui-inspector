import assert from "node:assert/strict";
import { test } from "node:test";
import { isDebugMetadata, MAX_DEBUG_METADATA_CAPTURE_BYTES, type DebugMetadata } from "../shared/debug-metadata";
import { isUiSnapshot } from "../shared/snapshot-validation";
import { parseSnapshotFile, serializeSnapshotFile } from "../shared/snapshot-file";
import { adoptSdkTree, joinSdkRefreshEvidence, joinSdkTreeAndDebugImages } from "../electron/sdk/sdk-hybrid";
import { commitViewRefresh } from "../electron/capture/view-refresh-commit";
import { makeNode } from "../benchmarks/fixtures";
import type { UiNode, UiSnapshot } from "../shared/types";
import { businessMetadataFixture } from "./fixtures/debug-metadata";

function fixture(count = 1) {
  const props = { visible: true, clickable: false, enabled: true, focusable: false, focused: false, selected: false,
    scrollable: false, alpha: 1, elevation: 0, paddingLeft: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0 };
  const bounds = { left: 0, top: 0, right: 10, bottom: 10, raw: "[0,0][10,10]" };
  const children = Array.from({ length: count }, (_, index) => ({ ...props, ref: `android.view.View@${(index + 2).toString(16)}`,
    className: "android.view.View", width: 10, height: 10, screenX: 0, screenY: 0, children: [] }));
  const sdk = { version: 1, debugMetadataVersion: 1, packageName: "sample.app", pid: 42,
    processInstance: "11111111-1111-1111-1111-111111111111", capturedAtMillis: 1, nodeCount: count + 1,
    root: { ...props, ref: "android.view.ViewGroup@1", className: "android.view.ViewGroup", width: 10, height: 10, screenX: 0, screenY: 0, children } };
  const nodes: UiNode[] = children.map((child, index) => ({ ...makeNode(`0/0/${index}`), className: child.className, text: null, bounds,
    attributes: { "view-ref": child.ref, "inspection-source": "debug-view" } }));
  const window: UiNode = { ...makeNode("0/0"), className: sdk.root.className, text: null, bounds,
    attributes: { "view-ref": sdk.root.ref, "inspection-source": "debug-view" }, children: nodes };
  const snapshot: UiSnapshot = { serial: "offline-fixture", root: { ...makeNode("0"), children: [window] }, nodeCount: count + 2,
    xmlSize: 0, rawXml: null, screenshotDataUrl: null, error: null, warning: null, inspectionSource: "debug-view", captureMode: "deep" };
  return { sdk, snapshot, node: nodes[0] };
}
function withMetadata(metadata: unknown = businessMetadataFixture) {
  const { sdk, snapshot } = fixture();
  return { snapshot, sdk: { ...sdk, root: { ...sdk.root, children: [{ ...sdk.root.children[0], debugMetadata: metadata }] } } };
}
function largeMetadata(): Extract<DebugMetadata, { status: "captured" }> {
  return { version: 1, source: "debug-sdk-explicit", status: "captured", groups: Array.from({ length: 3 }, (_, index) => ({
    key: `g${index}`, label: "Group", fields: Array.from({ length: 8 }, (_, i) => ({ key: `f${i}`, label: "Field", type: "string" as const, value: "x".repeat(512) })),
  })) };
}

test("explicit business values preserve types, zero, false, empty string and Unicode", () => {
  const { sdk, snapshot } = withMetadata();
  const before = structuredClone(snapshot);
  const joined = joinSdkTreeAndDebugImages(snapshot, sdk, "sample.app", 42);
  const value = joined.root!.children[0].children[0].debugMetadata!;
  assert.equal(joined.root!.attributes?.["sdk-debug-metadata-version"], "1");
  assert.deepEqual(value, businessMetadataFixture);
  assert.deepEqual(value.groups[1].fields.slice(0, 3).map(field => field.value), [false, 0, ""]);
  assert.deepEqual(snapshot, before, "joining must not mutate the original tree");
  sdk.root.children[0].debugMetadata = null;
  assert.deepEqual(value, businessMetadataFixture, "accepted values must not retain a mutable source object");
  const unicode = structuredClone(businessMetadataFixture);
  unicode.groups[0].fields[0] = { key: "unicode", label: "特殊字符", type: "string", value: '中😀\n"\\</script>' };
  assert.equal(isDebugMetadata(unicode), true);
});

test("business metadata schema rejects coercion, unsupported types and executable or extra fields", () => {
  const valid = businessMetadataFixture;
  for (const value of [null, [], {}, { ...valid, version: 2 }, { ...valid, source: "inferred" }, { ...valid, status: "unknown" },
    { ...valid, action: "run" }, { ...valid, groups: [] }, { ...valid, groups: [{ ...valid.groups[0], callback: "read" }] }])
    assert.equal(isDebugMetadata(value), false);
  for (const [type, value] of [["boolean", "false"], ["number", "0"], ["string", null], ["object", {}], ["number", NaN], ["number", Infinity], ["number", Number.MAX_SAFE_INTEGER + 1], ["string", "\ud800"]]) {
    const bad = structuredClone(valid);
    Object.assign(bad.groups[0].fields[0], { type, value });
    const data = withMetadata(bad);
    assert.equal(isDebugMetadata(bad), false);
    assert.throws(() => joinSdkTreeAndDebugImages(data.snapshot, data.sdk, "sample.app", 42), /业务信息/);
  }
});

test("group and field identities, counts, labels and Unicode byte limits are bounded", () => {
  const invalid = (mutate: (value: Extract<DebugMetadata, { status: "captured" }>) => void) => {
    const value = structuredClone(businessMetadataFixture) as Extract<DebugMetadata, { status: "captured" }>;
    mutate(value); assert.equal(isDebugMetadata(value), false);
  };
  invalid(value => value.groups.push(value.groups[0]));
  invalid(value => value.groups[0].fields.push(value.groups[0].fields[0]));
  invalid(value => { value.groups = Array.from({ length: 5 }, (_, i) => ({ ...value.groups[0], key: `g${i}` })); });
  invalid(value => { value.groups[0].fields = Array.from({ length: 17 }, (_, i) => ({ ...value.groups[0].fields[0], key: `f${i}` })); });
  for (const key of ["", "a".repeat(65), "业务", "a/b", "1first"]) invalid(value => { value.groups[0].key = key; });
  for (const label of ["", "x".repeat(65), " leading", "trailing ", "line\nfeed", "\udc00"]) invalid(value => { value.groups[0].label = label; });
  invalid(value => { value.groups[0].fields[0] = { key: "long", label: "Long", type: "string", value: "x".repeat(513) }; });
  const big = largeMetadata(); assert.equal(isDebugMetadata(big), true);
  for (const group of big.groups) for (const field of group.fields) field.value = "中".repeat(512);
  assert.equal(isDebugMetadata(big), false, "character count alone must not bypass the UTF-8 budget");
});

test("metadata needs an advertised, supported SDK capability while old SDK trees remain compatible", () => {
  const { sdk, snapshot } = withMetadata();
  for (const version of [undefined, 2, "1"]) assert.throws(() => joinSdkTreeAndDebugImages(snapshot, { ...sdk, debugMetadataVersion: version }, "sample.app", 42), /业务信息/);
  const old = fixture();
  assert.doesNotThrow(() => joinSdkTreeAndDebugImages(old.snapshot, { ...old.sdk, debugMetadataVersion: undefined }, "sample.app", 42));
});

test("refresh replaces business values and removes deleted or absent registrations", () => {
  const { sdk, snapshot } = withMetadata();
  const joined = joinSdkTreeAndDebugImages(snapshot, sdk, "sample.app", 42);
  const live = { ...joined, inspectionSource: "debug-view" as const };
  const fresh = structuredClone(sdk);
  fresh.root.children[0].debugMetadata = { version: 1, source: "debug-sdk-explicit", status: "captured", groups: [
    { key: "state", label: "页面状态", fields: [{ key: "loading", label: "加载中", type: "boolean", value: true }] },
  ] };
  const renewed = joinSdkRefreshEvidence(live, fresh, "sample.app", 42, sdk.processInstance);
  assert.deepEqual(renewed.root!.children[0].children[0].debugMetadata, fresh.root.children[0].debugMetadata);
  const cleared = fixture().sdk;
  for (const version of [1, undefined]) {
    const result = joinSdkRefreshEvidence(live, { ...cleared, debugMetadataVersion: version }, "sample.app", 42, sdk.processInstance);
    assert.equal(Object.prototype.hasOwnProperty.call(result.root!.children[0].children[0], "debugMetadata"), false);
    assert.equal(result.root!.attributes?.["sdk-debug-metadata-version"], version === 1 ? "1" : "");
  }
  const session = { requestId: "refresh", snapshot: joined };
  const freshNode = fixture().node;
  commitViewRefresh(session, session, freshNode.id, { nodes: [freshNode], failures: [] }, new AbortController().signal);
  assert.equal(session.snapshot.root!.children[0].children[0].debugMetadata, undefined);
});

test("SDK adoption keeps business info on real View identities and never on the activity wrapper", () => {
  const { sdk, snapshot } = withMetadata();
  snapshot.root!.debugMetadata = structuredClone(businessMetadataFixture);
  for (const mode of ["checked-dump", "merged-capture"] as const) {
    const root = structuredClone(snapshot.root!);
    adoptSdkTree(root, sdk, "sample.app", 42, mode);
    assert.deepEqual(root.children[0].children[0].debugMetadata, businessMetadataFixture);
    assert.equal(root.debugMetadata, undefined);
  }
});

test("whole capture metadata is bounded and valid omission markers retain an honest missing-value state", () => {
  const budget = { bytes: 0 }, large = largeMetadata();
  let accepted = 0;
  while (isDebugMetadata(large, budget)) accepted++;
  assert.ok(accepted > 1 && accepted < 30 && budget.bytes <= MAX_DEBUG_METADATA_CAPTURE_BYTES);
  const omitted: DebugMetadata = { version: 1, source: "debug-sdk-explicit", status: "omitted-budget", groups: [] };
  assert.equal(isDebugMetadata(omitted, budget), true);
  assert.equal(isDebugMetadata({ ...omitted, groups: businessMetadataFixture.groups }), false);
  const { sdk, snapshot } = fixture(accepted + 1);
  const tooMuch = { ...sdk, root: { ...sdk.root, children: sdk.root.children.map(child => ({ ...child, debugMetadata: large as DebugMetadata })) } };
  assert.throws(() => joinSdkTreeAndDebugImages(snapshot, tooMuch, "sample.app", 42), /额度/);
  tooMuch.root.children.at(-1)!.debugMetadata = omitted;
  const result = joinSdkTreeAndDebugImages(snapshot, tooMuch, "sample.app", 42);
  assert.equal(result.root!.children[0].children.at(-1)!.debugMetadata?.status, "omitted-budget");
  assert.equal(isUiSnapshot(result), true);
  result.root!.children[0].children.at(-1)!.debugMetadata = large;
  assert.equal(isUiSnapshot(result), false);
});

test("complete snapshot files preserve business info and reject corrupt metadata", () => {
  const { sdk, snapshot } = withMetadata();
  const joined = joinSdkTreeAndDebugImages(snapshot, sdk, "sample.app", 42);
  assert.equal(isUiSnapshot(joined), true);
  const file = JSON.parse(serializeSnapshotFile(joined, "2026-10-11T01:00:00.000Z"));
  assert.deepEqual(parseSnapshotFile(file).snapshot, joined);
  file.snapshot.root.children[0].children[0].debugMetadata.groups[0].fields[0].value = {};
  assert.equal(isUiSnapshot(file.snapshot), false);
  assert.throws(() => parseSnapshotFile(file), /无效|格式/);
});
