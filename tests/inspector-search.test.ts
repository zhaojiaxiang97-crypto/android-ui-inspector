import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { inspectorSearchPreview, MAX_INSPECTOR_SEARCH_RESULTS, searchInspectorProperties, type InspectorSearchProperty } from "../shared/inspector-search";

const property = (value: string, id = value): InspectorSearchProperty => ({ id, group: "business", section: "业务信息 · 状态", label: "原值", value, terms: value === "" ? ["空字符串 empty ∅"] : [] });

describe("inspector property search", () => {
  test("matches case-insensitive names, complete values, zero, false and empty-string terms", () => {
    const fields = [property("0"), property("false"), property(""), property("Long_".repeat(80) + "UNIQUE_END")];
    assert.equal(searchInspectorProperties(fields, "  FALSE  ").results[0].value, "false");
    assert.equal(searchInspectorProperties(fields, "0").results[0].value, "0");
    assert.equal(searchInspectorProperties(fields, "空字符串").results[0].value, "");
    assert(searchInspectorProperties(fields, "unique_end").results[0].value.endsWith("UNIQUE_END"));
    assert.equal(searchInspectorProperties(fields, "原值").total, 4);
    assert.equal(searchInspectorProperties(fields, " \t ").total, 0);
  });
  test("caps visible results while counting all matches and all matching groups", () => {
    const fields = Array.from({ length: MAX_INSPECTOR_SEARCH_RESULTS + 25 }, (_, index) => property("match", String(index)));
    fields[fields.length - 1].group = "raw";
    const found = searchInspectorProperties(fields, "match");
    assert.equal(found.total, fields.length);
    assert.equal(found.results.length, MAX_INSPECTOR_SEARCH_RESULTS);
    assert.deepEqual([...found.groups], ["business", "raw"]);
    assert.equal(found.results[0], fields[0]);
  });
  test("preview shortening never changes searchable or copyable original values", () => {
    const field = property("完整值_".repeat(100) + "END");
    const original = field.value;
    assert.equal(inspectorSearchPreview(field.value).length, 101);
    assert.equal(inspectorSearchPreview(""), "（空字符串）");
    assert.equal(inspectorSearchPreview("0"), "0");
    assert.equal(searchInspectorProperties([field], "END").results[0].value, original);
  });
});
