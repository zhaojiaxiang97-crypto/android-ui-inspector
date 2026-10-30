import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SnapshotHistory } from "../src/features/history/SnapshotHistory";
import type { SavedSnapshot } from "../src/features/history/model";

test("snapshot history exposes all retained items for selective deletion, including older ones", () => {
  const entries: SavedSnapshot[] = Array.from({ length: 8 }, (_, index) => ({
    id: `saved-${index}`, capturedAt: new Date(index * 1000).toISOString(),
    savedAt: new Date(index * 1000).toISOString(),
    snapshot: { serial: `fixture-${index}`, root: null, nodeCount: index + 1,
      xmlSize: 0, rawXml: null, screenshotDataUrl: null, warning: null, error: null },
    diff: null,
  }));
  const markup = renderToStaticMarkup(createElement(SnapshotHistory, {
    entries, onSelect: () => {}, onDelete: () => {},
  }));
  assert.equal((markup.match(/class="snapshot-history-row"/g) ?? []).length, 8);
  assert.equal((markup.match(/class="snapshot-history-delete"/g) ?? []).length, 8);
  assert.match(markup, /fixture-0/);
  assert.match(markup, /fixture-7/);
  assert.match(markup, /saved-0/);
});
