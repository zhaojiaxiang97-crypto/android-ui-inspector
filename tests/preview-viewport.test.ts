import assert from "node:assert/strict";
import { test } from "node:test";
import { unobscuredViewport } from "../shared/preview-viewport";

test("fitting avoids a full-height docked inspector and keeps a gap", () => {
  assert.deepEqual(unobscuredViewport(1000, 600, { left: 680, top: 12, width: 312, height: 576 }), { left: 0, top: 0, width: 672, height: 600 });
});
test("collapsed and moved floating panels release the largest clear region", () => {
  assert.deepEqual(unobscuredViewport(1000, 600, { left: 800, top: 16, width: 176, height: 32 }), { left: 0, top: 56, width: 1000, height: 544 });
  assert.deepEqual(unobscuredViewport(1000, 700, { left: 350, top: 250, width: 300, height: 160 }), { left: 0, top: 418, width: 1000, height: 282 });
});
test("closed and out-of-frame inspectors keep the full viewport", () => {
  for (const panel of [null, { left: 1000, top: 0, width: 300, height: 600 }, { left: -400, top: 0, width: 300, height: 600 }])
    assert.deepEqual(unobscuredViewport(1000, 600, panel), { left: 0, top: 0, width: 1000, height: 600 });
});
