import { test } from "node:test";
import assert from "node:assert/strict";
import { preferencesReadingPosition } from "../src/features/inspection/preferences-navigation";

const sections = [
  { id: "interaction", top: 0 }, { id: "appearance", top: 320 },
  { id: "layout", top: 520 }, { id: "properties", top: 680 }, { id: "help", top: 1380 },
] as const;

test("reading position follows the section heading and retains its local offset", () => {
  assert.deepEqual(preferencesReadingPosition(375, sections), { section: "appearance", offset: 55 });
  assert.deepEqual(preferencesReadingPosition(680, sections), { section: "properties", offset: 0 });
  assert.deepEqual(preferencesReadingPosition(0, sections), { section: "interaction", offset: 0 });
});

test("the last short section remains current when the scroll area reaches its end", () => {
  assert.deepEqual(preferencesReadingPosition(1220, sections, true), { section: "help", offset: -160 });
  assert.deepEqual(preferencesReadingPosition(1220, sections), { section: "properties", offset: 540 });
});

test("reading offsets adapt to new section sizes and invalid positions fall back safely", () => {
  const moved = sections.map(section => ({ ...section, top: section.top * 1.5 }));
  assert.deepEqual(preferencesReadingPosition(1075, moved), { section: "properties", offset: 55 });
  assert.deepEqual(preferencesReadingPosition(Number.NaN, sections), { section: "interaction", offset: 0 });
  assert.deepEqual(preferencesReadingPosition(-30, sections), { section: "interaction", offset: 0 });
  assert.deepEqual(preferencesReadingPosition(20, []), { section: "interaction", offset: 0 });
});
