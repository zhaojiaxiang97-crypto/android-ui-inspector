import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { makeNode } from "../benchmarks/fixtures";
import type { UiSnapshot } from "../shared/types";
import { SelectorMatchDiagnostics } from "../src/features/automation/SelectorMatchDiagnostics";
import type { DebugSelector } from "../src/features/automation/selector-match-diagnostics";

function snapshot(): UiSnapshot {
  const root = makeNode("root"), target = makeNode("target", 1); root.text = null;
  target.text = "READY"; target.resourceId = "app:id/ready"; root.children = [target];
  return { serial: "local-fixture", root, nodeCount: 2, rawXml: null, xmlSize: 0, screenshotDataUrl: null, error: null, warning: null };
}
function render(value: UiSnapshot | null, selector: DebugSelector) { return renderToStaticMarkup(<SelectorMatchDiagnostics snapshot={value} selector={selector} onSelectMatch={() => {}} />); }

test("default compact diagnostics expose stable hooks and keep Checker separate", () => {
  const html = render(snapshot(), { text: "READY", resourceId: "app:id/ready" });
  assert.match(html, /data-selector-diagnostic="ready"/); assert.doesNotMatch(html, /<details[^>]*\sopen(?:\s|=|>)/);
  assert.match(html, /精确匹配 1 个/); assert.match(html, /data-selector-action="select" data-node-id="target"/);
  assert.match(html, /根包名/); assert.match(html, /来源未记录（旧快照）/); assert.match(html, /不能替代 Checker/);
  assert.match(html, /可见/); assert.match(html, /启用/); assert.match(html, /位置/); assert.doesNotMatch(html, /验收通过/);
});

test("references explain mismatches and have no navigation control", () => {
  const html = render(snapshot(), { text: "ready", resourceId: "app:id/ready" });
  assert.match(html, /精确匹配 0 个/); assert.match(html, /data-selector-match="reference"/); assert.match(html, /文字不匹配/);
  assert.match(html, /忽略大小写后相同/); assert.doesNotMatch(html, /data-selector-action="select"/);
});

test("invalid conditions, empty and failed snapshots have useful states without candidates", () => {
  const cases: [UiSnapshot | null, DebugSelector, string][] = [
    [snapshot(), {}, "invalid-selector"], [null, { text: "READY" }, "unavailable"], [{ ...snapshot(), error: "offline" }, { text: "READY" }, "unavailable"],
  ];
  for (const [value, selector, status] of cases) {
    const html = render(value, selector); assert.match(html, new RegExp(`data-selector-diagnostic="${status}"`));
    assert.doesNotMatch(html, /data-selector-action="select"/); assert.match(html, /role="(?:status|alert)"/);
  }
});

test("duplicate IDs and invalid positions cannot offer enabled navigation", () => {
  for (const modify of [
    (value: UiSnapshot) => { value.root!.id = "target"; },
    (value: UiSnapshot) => { value.root!.children[0].bounds!.right = 0; },
  ]) {
    const value = snapshot(); modify(value); const html = render(value, { text: "READY" });
    assert.match(html, /<button[^>]*disabled=""/); assert.match(html, /不能确定|不能核对/);
  }
});

test("long untrusted text is bounded, escaped, and not promoted into selector edits", () => {
  const value = snapshot(); value.root!.children[0].contentDesc = "<img onerror=alert(1)>" + "中".repeat(5_000);
  const html = render(value, { text: "READY" });
  assert.match(html, /展示已截短/); assert.doesNotMatch(html, /<img/); assert.ok(html.length < 8_000);
  assert.doesNotMatch(html, /自动填写|data-selector-action="apply"/);
});
