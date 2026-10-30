import assert from "node:assert/strict";
import { test } from "node:test";
import { makeNode } from "../benchmarks/fixtures";
import { layoutRuleValue, parseLayoutRules, resolveLayoutRelations, type LayoutRules } from "../shared/layout-relations";

function fixture(type: LayoutRules["type"] = "ConstraintLayout") {
  const root = makeNode("opaque-root"), parent = makeNode("container-no-path"), source = makeNode("source-no-path"), first = makeNode("first"), second = makeNode("second");
  parent.className = type === "RelativeLayout" ? "android.widget.RelativeLayout" : "androidx.constraintlayout.widget.ConstraintLayout";
  source.resourceId = "com.example.app:id/source"; first.resourceId = "com.example.app:id/title"; second.resourceId = "com.example.app:id/body";
  root.children = [parent]; parent.children = [source, first, second];
  const relations = (rules: LayoutRules["rules"]) => resolveLayoutRelations(root, source, { type, rules });
  return { root, parent, source, first, second, relations };
}

test("layout anchors preserve distinct targets, real parent and source data with opaque UI IDs", () => {
  const { root, source, parent, first, second, relations } = fixture();
  const before = JSON.stringify(root);
  const rows = relations([["leftToLeft", first.resourceId!], ["topToBottom", second.resourceId!], ["rightToRight", "parent"]]);
  assert.deepEqual(rows.map(row => row.target), [first, second, parent]);
  assert(rows.every(row => row.status === "resolved"));
  assert.equal(rows[0].value, first.resourceId);
  assert.notEqual(rows[0].target, source);
  assert.equal(JSON.stringify(root), before);
});

test("relative anchors resolve siblings while boolean parent rules and scalar strings remain values", () => {
  const { first, relations } = fixture("RelativeLayout");
  const rows = relations([["below", first.resourceId!], ["alignParentTop", true], ["centerHorizontal", false], ["above", "parent"],
    ["horizontalBias", first.resourceId!], ["circleRadius", "0"], ["circleAngle", "30"], ["dimensionRatio", "16:9"], ["weight", "0"]]);
  assert.equal(rows[0].target, first);
  assert.equal(rows[3].reason, "invalid-parent-target");
  assert(rows.filter((_, i) => i !== 0 && i !== 3).every(row => row.status === "value" && row.target === null));
  assert.equal(relations([["below", true]])[0].status, "value");
  assert.equal(relations([["topToBottom", first.resourceId!]])[0].status, "value");
});

test("matching uses the complete resource ID among direct siblings, never nested or other branches", () => {
  const { root, parent, first, second, relations } = fixture();
  const outside = makeNode("outside"), nested = makeNode("nested");
  outside.resourceId = first.resourceId; nested.resourceId = first.resourceId;
  root.children.unshift(outside); second.children = [nested];
  assert.equal(relations([["startToEnd", first.resourceId!]])[0].target, first);
  first.resourceId = "different.package:id/title";
  assert.equal(relations([["startToEnd", "com.example.app:id/title"]])[0].reason, "missing-target");
  assert.equal(relations([["startToEnd", "different.package:id/title"]])[0].target, first);
  parent.resourceId = "com.example.app:id/parent";
  assert.equal(relations([["endToEnd", parent.resourceId]])[0].reason, "missing-target");
});

test("duplicate IDs including the current node stay ambiguous, and a self target is not navigable", () => {
  const { source, parent, first, relations } = fixture();
  const duplicate = makeNode("duplicate"); duplicate.resourceId = first.resourceId; parent.children.push(duplicate);
  const ambiguous = relations([["baselineToTop", first.resourceId!]])[0];
  assert.equal(ambiguous.reason, "duplicate-id"); assert.equal(ambiguous.target, null);
  assert.equal(relations([["circleConstraint", source.resourceId!]])[0].reason, "self-reference");
  duplicate.resourceId = source.resourceId;
  assert.equal(relations([["circleConstraint", source.resourceId!]])[0].reason, "duplicate-id");
});

test("short, numeric, prefixed and whitespace IDs remain intact and cannot become links", () => {
  const { relations } = fixture();
  for (const value of ["title", "id/title", "@id/title", "@+id/title", "id/0x7f080012", "7f080012", "0", "", " com.example.app:id/title", "com.example.app:id/title ", "garbage:com.example.app:id/title", "com.example.app:id/title/path"]) {
    const row = relations([["topToTop", value]])[0];
    assert.equal(row.status, "unresolved", value); assert.equal(row.reason, "incomplete-id", value);
    assert.equal(row.target, null, value); assert.equal(row.value, value);
  }
});

test("foreign and missing-parent nodes and insufficient layout types produce clear non-link results", () => {
  const { root, source, parent, first, relations } = fixture();
  const rules: LayoutRules = { type: "ConstraintLayout", rules: [["leftToLeft", "parent"], ["topToBottom", first.resourceId!]] };
  assert(resolveLayoutRelations(root, { ...source }, rules).every(row => row.reason === "missing-node"));
  assert(resolveLayoutRelations(source, source, rules).every(row => row.reason === "missing-parent"));
  parent.className = "my.app.NotConstraintLayout";
  assert(relations(rules.rules).every(row => row.reason === "unconfirmed-parent"));
  parent.className = "ConstraintLayout";
  assert(relations(rules.rules).every(row => row.reason === "unconfirmed-parent"));
  parent.className = "my.app.CustomLayout";
  parent.attributes = { "sdk-class-hierarchy": "my.app.CustomLayout → androidx.constraintlayout.widget.ConstraintLayout → android.view.ViewGroup → android.view.View" };
  assert.deepEqual(relations(rules.rules).map(row => row.target), [parent, first]);
  parent.children = [source];
  assert.equal(relations([["topToBottom", first.resourceId!]])[0].reason, "missing-target");
});

test("all known constraint anchors are references, while bias, radius, angle and booleans remain scalar values", () => {
  const { first, relations } = fixture();
  for (const name of ["leftToLeft", "leftToRight", "rightToLeft", "rightToRight", "startToStart", "startToEnd", "endToStart", "endToEnd",
    "topToTop", "topToBottom", "bottomToTop", "bottomToBottom", "baselineToBaseline", "baselineToTop", "baselineToBottom", "circleConstraint"]) {
    assert.equal(relations([[name, first.resourceId!]])[0].target, first, name);
  }
  assert(relations([["horizontalBias", "0.5"], ["verticalBias", "0"], ["circleRadius", "0"], ["circleAngle", "0"], ["dimensionRatio", "1:1"],
    ["unknownFutureRule", first.resourceId!], ["topToTop", false]]).every(row => row.status === "value"));
});

test("old scalar display and parser behavior retain search terms and preserve false, zero and empty values", () => {
  for (const raw of [undefined, "", "{", "null", "[]", '{"type":"LinearLayout","rules":{}}', '{"type":"ConstraintLayout","rules":[]}'])
    assert.equal(parseLayoutRules(raw), null);
  assert.deepEqual(parseLayoutRules('{"type":"RelativeLayout","rules":{"below":"com.example.app:id/title","centerHorizontal":false,"empty":"","zero":"0","invalid":1}}'), {
    type: "RelativeLayout", rules: [["below", "com.example.app:id/title"], ["centerHorizontal", false], ["empty", ""], ["zero", "0"]],
  });
  assert.equal(layoutRuleValue("below", "com.example.app:id/title"), "id/title");
  assert.equal(layoutRuleValue("leftToLeft", "parent"), "父容器");
  assert.equal(layoutRuleValue("centerHorizontal", false), "否");
  assert.equal(layoutRuleValue("horizontalBias", "0.5"), "50%");
  assert.equal(layoutRuleValue("verticalBias", "0"), "0%");
  assert.equal(layoutRuleValue("circleRadius", "24.555"), "24.56px");
  assert.equal(layoutRuleValue("circleAngle", "0"), "0°");
  assert.equal(layoutRuleValue("dimensionRatio", ""), "—");
});
