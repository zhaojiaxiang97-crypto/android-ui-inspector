import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectionProvenance } from "../shared/inspection-provenance";
import type { UiSnapshot } from "../shared/types";

const empty = (source: UiSnapshot["inspectionSource"]) => ({
  serial: "fixture", root: null, nodeCount: 0, xmlSize: 0, rawXml: null, screenshotDataUrl: null,
  error: null, warning: null, inspectionSource: source,
}) satisfies UiSnapshot;

test("provenance never treats screenshots or fast semantics as real-time action identity", () => {
  for (const source of ["uiautomator", "accessibility-helper", "debug-view", "debug-qml"] as const) {
    const data = inspectionProvenance(empty(source));
    assert.equal(data.actionIdentity, "fresh-authorized-revalidation-required");
    assert.notEqual(data.screenshotRelation, "same-frame");
    assert.equal(data.treeKind === "accessibility-semantics", source === "uiautomator" || source === "accessibility-helper");
    assert.equal(JSON.stringify(data).includes("PRIVATE"), false);
  }
  assert.equal(inspectionProvenance({ ...empty("uiautomator"), hierarchyDumpMode: "compressed" }).completeness, "filtered");
  assert.equal(inspectionProvenance({ ...empty("accessibility-helper") }).completeness, "unverified");
});
