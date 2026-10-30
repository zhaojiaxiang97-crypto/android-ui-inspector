import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { searchInspectorProperties, type InspectorSearchProperty } from "../shared/inspector-search";

const fields = (length: number): InspectorSearchProperty[] => Array.from({ length }, (_, index) => ({
  id: `path/${index}`, group: index < 30 ? "business" : "raw", section: `状态/${index}`, label: "同名",
  value: ["", "0", "false", "null", "Unicode 中文 🦊\n完整值".repeat(40)][index % 5], terms: ["match", `path/${index}`],
}));

describe("complete inspector search pages", () => {
  for (const total of [0, 1, 30, 31, 1000]) test(`${total} matches remain reachable once with original objects and values`, () => {
    const values = fields(total), first = searchInspectorProperties(values, "match");
    assert.equal(first.total, total);
    assert.equal(first.page.count, Math.ceil(total / 30));
    assert.equal(first.page.start, total ? 1 : 0);
    assert.equal(first.page.end, Math.min(30, total));
    const reached: InspectorSearchProperty[] = [];
    for (let index = 0; index < first.page.count; index++) {
      const page = searchInspectorProperties(values, "match", index);
      assert.equal(page.page.index, index);
      assert.equal(page.page.start, index * 30 + 1);
      assert.equal(page.page.end, Math.min((index + 1) * 30, total));
      assert.deepEqual([...page.groups], [...first.groups]);
      assert(page.results.length <= 30);
      reached.push(...page.results);
    }
    assert.equal(reached.length, total);
    reached.forEach((value, index) => assert.equal(value, values[index]));
    assert.equal(new Set(reached.map(value => value.id)).size, total);
  });
  test("old callers receive the first page; invalid and obsolete page indexes clamp safely", () => {
    const values = fields(31);
    for (const index of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(searchInspectorProperties(values, "match", index).page.index, 0);
    const last = searchInspectorProperties(values, "match", 1000);
    assert.equal(last.page.index, 1);
    assert.deepEqual(last.results, [values[30]]);
    assert.equal(searchInspectorProperties(values.slice(0, 1), "match", 1).page.index, 0);
    assert.deepEqual(searchInspectorProperties(values, "   ", 1000).page, { index: 0, count: 0, start: 0, end: 0, size: 30 });
  });
  test("a path query finds the original long and empty values without matching pagination decoration", () => {
    const values = fields(1000);
    assert.equal(searchInspectorProperties(values, "path/999").results[0], values[999]);
    assert.equal(searchInspectorProperties(values, "path/995").results[0].value, "");
    assert.equal(searchInspectorProperties(values, "下一页").total, 0);
  });
});
