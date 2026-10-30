import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppMenuState } from "../shared/types";
import { commandEnabled, commandForShortcut, commandShortcut } from "../shared/workbench-commands";

const ready: AppMenuState = { devices: [{ serial: "fixture", model: "Fixture", state: "device" }], selectedSerial: "fixture",
  loading: false, capturing: false, inspecting: true, hasSnapshot: true, filtered: false,
  canFocus: true, canHideLayer: true, hasHiddenLayers: true, hasLayerFocus: true, selectedExpandable: true, selectedExpanded: true };

test("capture rejects stale devices after a failed probe and while busy", () => {
  assert.ok(commandEnabled("capture", ready));
  for (const state of [{ ...ready, canCapture: false }, { ...ready, loading: true }, { ...ready, capturing: true }, { ...ready, devices: [] }])
    assert.equal(commandEnabled("capture", state), false);
  assert.equal(commandEnabled("cancel", { ...ready, capturing: true }), true);
  assert.equal(commandEnabled("home", { ...ready, capturing: true }), true);
});

test("exports require their actual source, and history loading blocks save only", () => {
  assert.ok(commandEnabled("export-snapshot", ready));
  assert.ok(commandEnabled("export-json", ready));
  assert.equal(commandEnabled("export-xml", ready), false);
  assert.equal(commandEnabled("export-png", ready), false);
  assert.ok(commandEnabled("export-xml", { ...ready, hasRawXml: true }));
  assert.ok(commandEnabled("export-png", { ...ready, hasScreenshot: true }));
  assert.equal(commandEnabled("save", { ...ready, historyLoading: true }), false);
  for (const type of ["save", "export-snapshot", "export-json", "export-xml", "export-png"] as const)
    assert.equal(commandEnabled(type, { ...ready, capturing: true, hasRawXml: true, hasScreenshot: true }), false);
});

test("offline files can open without a device, with pending imports and active captures excluded", () => {
  assert.ok(commandEnabled("open-snapshot", undefined));
  assert.ok(commandEnabled("open-snapshot", { ...ready, devices: [], loading: true, hasSnapshot: false }));
  assert.equal(commandEnabled("open-snapshot", { ...ready, capturing: true }), false);
  assert.equal(commandEnabled("open-snapshot", { ...ready, openingSnapshot: true }), false);
  assert.equal(commandEnabled("open-snapshot", ready, true), false);
  assert.equal(commandEnabled("open-snapshot", ready, false, true), false);
});

test("filtered trees and fast snapshots disable the corresponding menu actions", () => {
  for (const type of ["expand-all", "collapse-all", "expand-selected", "collapse-selected"] as const)
    assert.equal(commandEnabled(type, { ...ready, filtered: true }), false);
  for (const type of ["focus-branch", "focus-layer"] as const)
    assert.equal(commandEnabled(type, { ...ready, canFocus: false }), false);
  assert.ok(commandEnabled("collapse-selected", ready));
  assert.equal(commandEnabled("expand-selected", ready), false);
  assert.equal(commandEnabled("hide-selected", { ...ready, canHideLayer: false }), false);
});

test("stop and preferences stay available without a snapshot", () => {
  assert.ok(commandEnabled("preferences", undefined));
  assert.ok(commandEnabled("test-report", undefined));
  assert.equal(commandEnabled("mcp-stop", undefined), false);
  assert.ok(commandEnabled("mcp-stop", undefined, true));
  assert.ok(commandEnabled("mcp-stop", undefined, false, true));
  assert.equal(commandEnabled("debug-start", ready, true), false);
  assert.equal(commandEnabled("mcp-share", ready, false, true), false);
});

test("platform shortcuts require the right modifier and distinguish capture from refresh", () => {
  const key = { key: "r", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false };
  assert.equal(commandForShortcut(key, true), "capture");
  assert.equal(commandForShortcut({ ...key, shiftKey: true }, true), "refresh");
  assert.equal(commandForShortcut(key, false), null);
  assert.equal(commandForShortcut({ ...key, metaKey: false, ctrlKey: true }, false), "capture");
  assert.equal(commandForShortcut({ ...key, altKey: true }, true), null);
  assert.equal(commandForShortcut({ ...key, ctrlKey: true }, true), null);
  assert.equal(commandForShortcut({ ...key, key: "," }, true), "preferences");
  assert.equal(commandForShortcut({ ...key, key: "o" }, true), "open-snapshot");
  assert.equal(commandForShortcut({ ...key, key: "S", shiftKey: true }, true), "export-json");
  assert.equal(commandShortcut("export-json", true), "⌘⇧S");
  assert.equal(commandShortcut("export-json", false), "Ctrl+Shift+S");
});
