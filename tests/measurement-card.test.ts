import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { measurementCardData, measurementCardDiagram, measurementCardNumber, measurementCardPlacement,
  measurementCardRelationLabel, measurementCardCopyText } from "../shared/measurement-card";
import type { UiBounds } from "../shared/types";

const bounds = (left: number, top: number, right: number, bottom: number): UiBounds => ({ left, top, right, bottom, raw: "original" });
const endpoint = (id: string, box: UiBounds | null) => ({ id, label: `${id} 控件`, bounds: box });

describe("two-dimensional measurement card", () => {
  test("keeps original pixel distances when the diagram is scaled", () => {
    const data = measurementCardData(endpoint("a", bounds(10, 20, 110, 120)), endpoint("b", bounds(134, 156, 180, 200)))!;
    assert.deepEqual(data.measurement.guides[0].distances, [{ label: "水平", value: 24 }, { label: "垂直", value: 36 }]);
    assert.equal(measurementCardRelationLabel(data), "外框分离");
    const original = JSON.stringify(data);
    const large = measurementCardDiagram(data, 248, 112)!, small = measurementCardDiagram(data, 124, 56)!;
    assert.ok(small.anchor.width < large.anchor.width);
    assert.equal(large.anchor.width / large.anchor.height, 1);
    assert.equal(small.anchor.width / small.anchor.height, 1);
    assert.equal(JSON.stringify(data), original);
    assert.equal(measurementCardNumber(12.345), "12.35");
    assert.equal(measurementCardNumber(24), "24");
  });

  test("preserves all containment insets and reverses A/B relation honestly", () => {
    const outer = endpoint("outer", bounds(10, 20, 110, 120)), inner = endpoint("inner", bounds(20, 35, 80, 90));
    const contains = measurementCardData(outer, inner)!, inside = measurementCardData(inner, outer)!;
    assert.equal(measurementCardRelationLabel(contains), "A 包含 B");
    assert.equal(measurementCardRelationLabel(inside), "B 包含 A");
    assert.deepEqual(contains.measurement.guides.map(guide => guide.distances[0]), [
      { label: "左", value: 10 }, { label: "右", value: 30 }, { label: "上", value: 15 }, { label: "下", value: 30 },
    ]);
    assert.deepEqual(inside.measurement.guides.map(guide => guide.distances), contains.measurement.guides.map(guide => guide.distances));
    assert.deepEqual(contains.alignments, []);
  });

  test("reports only real edge or center alignment, independently of rounded display values", () => {
    const a = endpoint("a", bounds(0, 0, 100, 100));
    const aligned = measurementCardData(a, endpoint("b", bounds(0, 140, 100, 160)))!;
    assert.deepEqual(aligned.alignments, ["左边对齐", "右边对齐", "左右中心对齐"]);
    const near = measurementCardData(a, endpoint("b", bounds(0.001, 140, 100.001, 160)))!;
    assert.deepEqual(near.alignments, []);
    const same = measurementCardData(a, endpoint("b", a.bounds))!;
    assert.equal(measurementCardRelationLabel(same), "边界重合");
    assert.deepEqual(same.alignments, ["四边与中心均对齐"]);
    assert.deepEqual(same.measurement.guides[0].distances, []);
    assert.equal(measurementCardRelationLabel(measurementCardData(a, endpoint("b", bounds(50, 50, 120, 120)))!), "外框重叠");
    assert.equal(measurementCardRelationLabel(measurementCardData(a, endpoint("b", bounds(100, 0, 120, 100)))!), "边缘相接");
  });

  test("draws off-screen coordinates within the diagram with matching proportions", () => {
    const data = measurementCardData(endpoint("a", bounds(-100, -50, -10, 10)), endpoint("b", bounds(10, 20, 110, 120)))!;
    const diagram = measurementCardDiagram(data)!;
    for (const rect of [diagram.anchor, diagram.target]) {
      assert.ok(rect.x >= 12 - 1e-10 && rect.y >= 12 - 1e-10);
      assert.ok(rect.x + rect.width <= diagram.width - 12 + 1e-10);
      assert.ok(rect.y + rect.height <= diagram.height - 12 + 1e-10);
    }
    assert.ok(Math.abs(diagram.anchor.width / diagram.target.width - 0.9) < 1e-10);
    assert.ok(Math.abs(diagram.anchor.height / diagram.target.height - 0.6) < 1e-10);
    assert.deepEqual(data.measurement.guides[0].distances, [{ label: "水平", value: 20 }, { label: "垂直", value: 10 }]);
  });

  test("snapshots the original bounds without mutating inputs", () => {
    const box = bounds(0, 0, 100, 100), other = bounds(120, 0, 150, 100);
    Object.freeze(box); Object.freeze(other);
    const data = measurementCardData(endpoint("a", box), endpoint("b", other))!;
    assert.deepEqual(data.anchor.bounds, box);
    assert.notEqual(data.anchor.bounds, box);
    assert.deepEqual(data.target.bounds, other);
    assert.equal(data.anchor.label, "a 控件");
    assert.equal(measurementCardDiagram(data, 0, 112), null);
    assert.equal(measurementCardDiagram(data, NaN, 112), null);
  });

  test("does not invent a pair for missing, zero-size or nonfinite bounds", () => {
    const a = endpoint("a", bounds(0, 0, 100, 100));
    assert.equal(measurementCardData(a, endpoint("a", bounds(120, 0, 150, 100))), null);
    for (const box of [null, bounds(0, 0, 0, 100), bounds(100, 0, 0, 100), bounds(NaN, 0, 100, 100), bounds(0, 0, Infinity, 100), bounds(-1e308, 0, 1e308, 100)]) {
      assert.equal(measurementCardData(a, endpoint("b", box)), null);
    }
  });

  test("positions the card inside available canvas bounds, including a short or narrow viewport", () => {
    for (const viewport of [{ left: 10, top: 20, width: 640, height: 480 }, { left: 300, top: 40, width: 180, height: 100 }]) {
      const placed = measurementCardPlacement(viewport)!;
      assert.ok(placed.left >= viewport.left);
      assert.ok(placed.left + placed.width <= viewport.left + viewport.width);
      assert.ok(placed.top + placed.maxHeight / 2 <= viewport.top + viewport.height);
      assert.ok(placed.top - placed.maxHeight / 2 >= viewport.top);
      assert.ok(placed.width <= 300);
      assert.ok(placed.left + placed.width > viewport.left + viewport.width - 13);
    }
    const viewport = { left: 0, top: 0, width: 640, height: 480 };
    assert.equal(measurementCardPlacement({ ...viewport, width: 100 }), null);
    assert.equal(measurementCardPlacement({ ...viewport, height: 40 }), null);
    assert.equal(measurementCardPlacement({ ...viewport, left: NaN }), null);
    assert.equal(measurementCardPlacement({ ...viewport, height: Infinity }), null);
  });

  test("compares the selected edges during partial overlap instead of reporting a zero gap", () => {
    const a = endpoint("a", bounds(10, 20, 110, 120)), b = endpoint("b", bounds(80, 80, 140, 160));
    const forward = measurementCardData(a, b)!, reverse = measurementCardData(b, a)!;
    assert.equal(forward.measurement.relation, "overlap");
    assert.deepEqual(forward.dimensions.map(value => [value.axis, value.label, value.value]), [["horizontal", "右", 30], ["vertical", "下", 40]]);
    assert.deepEqual(reverse.dimensions.map(value => [value.axis, value.label, value.value]), [["horizontal", "左", 70], ["vertical", "上", 60]]);
  });

  test("shows real per-axis insets, skips coincident edges and distinguishes contact from an edge offset", () => {
    const outer = endpoint("outer", bounds(0, 0, 200, 100)), inner = endpoint("inner", bounds(20, 15, 150, 70));
    for (const pair of [[outer, inner], [inner, outer]] as const) {
      assert.deepEqual(measurementCardData(...pair)!.dimensions.map(value => value.value), [20, 50, 15, 30]);
    }
    const same = measurementCardData(outer, endpoint("other", outer.bounds))!;
    assert.deepEqual(same.dimensions, []);
    const aligned = measurementCardData(outer, endpoint("b", bounds(0, 140, 200, 160)))!;
    assert.deepEqual(aligned.dimensions.map(value => [value.axis, value.value]), [["vertical", 40]]);
    const contact = measurementCardData(endpoint("a", bounds(0, 0, 100, 100)), endpoint("b", bounds(100, 0, 150, 100)))!;
    assert.equal(contact.measurement.relation, "touching");
    assert.deepEqual(contact.dimensions.map(value => [value.label, value.value]), [["右", 50]]);
  });

  test("keeps diagram distance badges within its bounds and separate from image opacity", () => {
    const data = measurementCardData(endpoint("a", bounds(-10, 20, 110, 100)), endpoint("b", bounds(-80, -120, 180, 241)))!;
    const source = JSON.stringify(data);
    for (const [width, height] of [[276, 300], [200, 150], [140, 96]]) {
      const diagram = measurementCardDiagram(data, width, height)!;
      assert.equal(diagram.dimensions.length, 4);
      for (const dimension of diagram.dimensions) {
        const label = dimension.labelBox;
        assert.ok(label.x >= 0 && label.y >= 0);
        assert.ok(label.x + label.width <= width && label.y + label.height <= height);
        assert.ok([dimension.from.x, dimension.from.y, dimension.to.x, dimension.to.y].every(Number.isFinite));
      }
    }
    assert.equal(JSON.stringify(data), source);
  });
});

describe("measurement result copy", () => {
  test("identifies compared edges, original pixels and supplied snapshot metadata", () => {
    const data = measurementCardData(endpoint("a", bounds(10, 20, 110, 120)), endpoint("b", bounds(134, 156, 180, 200)))!;
    const text = measurementCardCopyText(data, { id: "saved-123", capturedAt: "2026-10-13T01:00:00Z" });
    assert.ok(text.includes("快照 ID：saved-123") && text.includes("采集时间：2026-10-13T01:00:00Z"));
    assert.ok(text.includes("A：a 控件（节点 a）") && text.includes("B：b 控件（节点 b）"));
    assert.ok(text.includes("A 右边 → B 左边：24 px") && text.includes("A 下边 → B 上边：36 px"));
    const reversed = measurementCardCopyText(measurementCardData(data.target, data.anchor)!);
    assert.ok(reversed.includes("B 右边 → A 左边：24 px") && reversed.includes("B 下边 → A 上边：36 px"));
    assert.ok(reversed.includes("当前未保存快照（无快照 ID）") && !reversed.includes("快照 ID："));
  });

  test("does not invent a snapshot ID or lose equal-boundary results", () => {
    const a = endpoint("a", bounds(0, 0, 100, 100));
    const data = measurementCardData({ ...a, label: "多行\n控件" }, endpoint("b", a.bounds))!;
    const text = measurementCardCopyText(data, { label: "导入 fixture.auisnapshot" });
    assert.ok(text.includes("快照：导入 fixture.auisnapshot") && !text.includes("快照 ID：") && !text.includes("采集时间："));
    assert.ok(text.includes("A：多行 控件") && text.includes("四边对齐：0 px") && text.includes("四边与中心均对齐"));
    assert.ok(text.includes("屏幕 px（原始布局外框"));
  });
});
