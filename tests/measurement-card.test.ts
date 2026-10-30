import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { measurementCardData, measurementCardDiagram, measurementCardNumber, measurementCardPlacement,
  measurementCardRelationLabel } from "../shared/measurement-card";
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
      assert.ok(placed.bottomEdge <= viewport.top + viewport.height);
      assert.ok(placed.bottomEdge - placed.maxHeight >= viewport.top);
      assert.ok(placed.width <= 280);
    }
    const viewport = { left: 0, top: 0, width: 640, height: 480 };
    assert.equal(measurementCardPlacement({ ...viewport, width: 100 }), null);
    assert.equal(measurementCardPlacement({ ...viewport, height: 40 }), null);
    assert.equal(measurementCardPlacement({ ...viewport, left: NaN }), null);
    assert.equal(measurementCardPlacement({ ...viewport, height: Infinity }), null);
  });
});
