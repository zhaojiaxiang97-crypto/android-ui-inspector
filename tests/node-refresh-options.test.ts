import { test } from "node:test";
import assert from "node:assert/strict";
import { makeNode } from "../benchmarks/fixtures";
import { nodeRefreshScopeOptions } from "../shared/node-refresh-options";
import { isLayerMenuOptions } from "../shared/layer-context-menu";

test("node and branch refresh offer only the existing live View capabilities", () => {
  const node = makeNode("0"); node.attributes = { "view-ref": "View@1" }; node.children = [makeNode("0/0")];
  for (const source of ["debug-view", "debug-hybrid"] as const) {
    const scopes = nodeRefreshScopeOptions(node, { current: true, hasLiveRequest: true, source });
    assert(scopes.every(scope => scope.available));
    assert(isLayerMenuOptions({ canFocus: false, expandable: false, expanded: false, refreshScopes: scopes }));
  }
  const qml = nodeRefreshScopeOptions(node, { current: true, hasLiveRequest: true, source: "debug-qml" });
  assert(qml[0].available && !qml[1].available);
  node.children = [];
  const leaf = nodeRefreshScopeOptions(node, { current: true, hasLiveRequest: true, source: "debug-view" });
  assert(leaf[0].available && !leaf[1].available && leaf[1].detail.includes("子层"));
});

test("offline, missing references, stale targets and ongoing work explain refresh unavailability", () => {
  const node = makeNode("0"); node.attributes = { "view-ref": "View@1" }; node.children = [makeNode("0/0")];
  const base = { current: true, hasLiveRequest: true, source: "debug-view" as const };
  for (const patch of [{ current: false }, { hasLiveRequest: false }, { busy: "capture" as const }, { busy: "refresh" as const }, { blocked: true }]) {
    const scopes = nodeRefreshScopeOptions(node, { ...base, ...patch });
    assert(scopes.every(scope => !scope.available && scope.detail.length));
  }
  assert(nodeRefreshScopeOptions(null, base).every(scope => !scope.available));
  node.attributes = {};
  assert(nodeRefreshScopeOptions(node, base).every(scope => !scope.available && scope.detail.includes("引用")));
});
