import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_INSPECTOR_GROUPS, INSPECTOR_GROUPS, inspectorGroupVisible,
  inspectorDisclosureOpen, withInspectorDisclosure, MAX_INSPECTOR_GROUP_PREFERENCE_LENGTH, parseInspectorGroupPreference, readInspectorGroupPreference } from "../shared/inspector-groups";

test("default groups preserve all existing cards and allow every group to be hidden", () => {
  assert.deepEqual(INSPECTOR_GROUPS.map(group => group.id), ["type", "business", "relation", "layout", "interaction", "image", "raw"]);
  for (const group of INSPECTOR_GROUPS) assert.equal(inspectorGroupVisible(DEFAULT_INSPECTOR_GROUPS, group.id, false, false), true);
  const allHidden = parseInspectorGroupPreference({ version: 1, hidden: INSPECTOR_GROUPS.map(group => group.id) })!;
  assert(allHidden);
  for (const group of INSPECTOR_GROUPS) assert.equal(inspectorGroupVisible(allHidden, group.id, false, true), false);
});

test("valid storage round trips, removes duplicate IDs and returns independent arrays", () => {
  const original = { version: 1, hidden: ["layout", "image", "layout"] };
  const parsed = parseInspectorGroupPreference(original)!;
  assert.deepEqual(parsed, { version: 1, hidden: ["layout", "image"] });
  assert.deepEqual(original.hidden, ["layout", "image", "layout"]);
  original.hidden.push("raw");
  assert.deepEqual(parsed.hidden, ["layout", "image"]);
  assert.deepEqual(readInspectorGroupPreference(JSON.stringify(parsed)), parsed);
  assert.deepEqual(parseInspectorGroupPreference(DEFAULT_INSPECTOR_GROUPS), DEFAULT_INSPECTOR_GROUPS);
});

test("unknown IDs, unsupported versions and invalid preference shapes are rejected as a whole", () => {
  for (const value of [null, false, 1, "{}", [], {}, { version: 2, hidden: [] }, { version: "1", hidden: [] },
    { version: 1 }, { version: 1, hidden: null }, { version: 1, hidden: "image" }, { version: 1, hidden: {} },
    { version: 1, hidden: [null] }, { version: 1, hidden: [1] }, { version: 1, hidden: ["Image"] },
    { version: 1, hidden: [" image"] }, { version: 1, hidden: ["layout", "future"] }, { version: 1, hidden: ["__proto__"] }]) {
    assert.equal(parseInspectorGroupPreference(value), null, JSON.stringify(value));
    assert.deepEqual(readInspectorGroupPreference(JSON.stringify(value)), DEFAULT_INSPECTOR_GROUPS);
  }
});

test("corrupt, excessive and unavailable local values safely restore all groups", () => {
  for (const raw of [null, "", "null", "[", "{}", '{"version":1,"hidden":["raw",]}', " ".repeat(MAX_INSPECTOR_GROUP_PREFERENCE_LENGTH + 1),
    JSON.stringify({ version: 1, hidden: Array.from({ length: 1000 }, () => "type") }),
    JSON.stringify({ version: 1, hidden: [], extra: "x".repeat(MAX_INSPECTOR_GROUP_PREFERENCE_LENGTH) })]) {
    assert.deepEqual(readInspectorGroupPreference(raw), DEFAULT_INSPECTOR_GROUPS);
  }
  const valid = JSON.stringify({ version: 1, hidden: ["raw"] });
  assert.deepEqual(readInspectorGroupPreference(valid.padEnd(MAX_INSPECTOR_GROUP_PREFERENCE_LENGTH, " ")), { version: 1, hidden: ["raw"] });
  assert.equal(parseInspectorGroupPreference({ version: 1, hidden: Array.from({ length: MAX_INSPECTOR_GROUP_PREFERENCE_LENGTH + 1 }, () => "raw") }), null);
  const cyclic: { version: 1; hidden: string[]; self?: unknown } = { version: 1, hidden: [] };
  cyclic.self = cyclic;
  assert.equal(parseInspectorGroupPreference(cyclic), null);
  assert.equal(parseInspectorGroupPreference({ get version(): number { throw new Error("bad storage value"); }, hidden: [] }), null);
});

test("search temporarily shows matching hidden groups without changing preferences", () => {
  const preference = parseInspectorGroupPreference({ version: 1, hidden: ["layout", "image"] })!;
  assert.equal(inspectorGroupVisible(preference, "layout", true, true), true);
  assert.equal(inspectorGroupVisible(preference, "image", true, false), false);
  assert.equal(inspectorGroupVisible(preference, "raw", true, false), false);
  assert.equal(inspectorGroupVisible(preference, "raw", true, true), true);
  assert.equal(inspectorGroupVisible(preference, "layout", false, true), false);
  assert.equal(inspectorGroupVisible(preference, "raw", false, false), true);
  assert.deepEqual(preference.hidden, ["layout", "image"]);
});

test("legacy visibility settings inherit compact disclosure defaults", () => {
  const preference = readInspectorGroupPreference('{"version":1,"hidden":["image"]}');
  assert.equal(inspectorDisclosureOpen(preference, "type"), false);
  assert.equal(inspectorDisclosureOpen(preference, "relation"), false);
  assert.equal(inspectorDisclosureOpen(preference, "layout"), false);
  assert.equal(inspectorDisclosureOpen(preference, "business"), true);
  assert.equal(inspectorDisclosureOpen(preference, "image"), true);
  assert.equal(inspectorDisclosureOpen(preference, "padding"), false);
  assert.deepEqual(preference.hidden, ["image"]);
});

test("explicit nested and top-level disclosure overrides persist without changing visibility", () => {
  const original = readInspectorGroupPreference('{"version":1,"hidden":["relation"]}');
  const expanded = withInspectorDisclosure(original, "type", true);
  const collapsed = withInspectorDisclosure(withInspectorDisclosure(expanded, "padding", true), "image", false);
  const restored = readInspectorGroupPreference(JSON.stringify(collapsed));
  assert.equal(inspectorDisclosureOpen(restored, "type"), true);
  assert.equal(inspectorDisclosureOpen(restored, "padding"), true);
  assert.equal(inspectorDisclosureOpen(restored, "image"), false);
  assert.deepEqual(restored.hidden, ["relation"]);
  assert.equal(original.expanded, undefined);
  assert.deepEqual(expanded.expanded, { type: true });
  assert.equal(inspectorDisclosureOpen(DEFAULT_INSPECTOR_GROUPS, "type"), false);
  assert.equal(inspectorDisclosureOpen(DEFAULT_INSPECTOR_GROUPS, "image"), true);
});

test("disclosure parsing clones valid values and rejects unknown or non-boolean states", () => {
  const original = { version: 1, hidden: [], expanded: { type: true, "image-details": false } };
  const parsed = parseInspectorGroupPreference(original)!;
  original.expanded.type = false;
  assert.equal(parsed.expanded?.type, true);
  for (const expanded of [null, [], true, "type", { type: 1 }, { type: "false" }, { unknown: true },
    JSON.parse('{"__proto__":true}'), { constructor: false }, { " type": true }]) {
    assert.equal(parseInspectorGroupPreference({ version: 1, hidden: [], expanded }), null);
  }
});
