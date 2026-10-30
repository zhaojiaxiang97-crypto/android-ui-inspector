import assert from "node:assert/strict";
import { test } from "node:test";
import { pixelDifferenceSummary } from "../benchmarks/pixel-difference";

test("pixel diagnostics keep exact one-level differences and independent child contribution", () => {
  const parent = new Uint8ClampedArray([10, 10, 10, 255, 10, 10, 10, 255]);
  const expected = new Uint8ClampedArray([20, 20, 20, 255, 10, 10, 10, 255]);
  const actual = new Uint8ClampedArray([21, 19, 20, 255, 10, 10, 10, 254]);
  const result = pixelDifferenceSummary(actual, expected, 2, 1, parent);
  assert.equal(result.mismatchedPixels, 2);
  assert.equal(result.maxChannelDelta, 1);
  assert.equal(result.alphaMismatches, 1);
  assert.deepEqual(result.signedChannelDeltas, { "R:1": 1, "G:-1": 1, "A:-1": 1 });
  assert.equal(result.withChildContribution, 1);
  assert.equal(result.withoutChildContribution, 1);
  assert.deepEqual(result.bounds, { left: 0, top: 0, right: 2, bottom: 1 });
});

test("pixel diagnostics have no false mismatch, bounded samples and no input mutation", () => {
  const input = new Uint8ClampedArray(80).fill(255), other = new Uint8ClampedArray(80).fill(254);
  assert.equal(pixelDifferenceSummary(input, input, 5, 4).bounds, null);
  const result = pixelDifferenceSummary(input, other, 5, 4);
  assert.equal(result.samples.length, 8);
  assert.equal(result.mismatchedPixels, 20);
  assert.equal(result.alphaMismatches, 20);
  assert.equal(input.every(value => value === 255), true);
  assert.equal(other.every(value => value === 254), true);
  assert.equal("withChildContribution" in result, false);
});

test("pixel diagnostics reject invalid dimensions, incomplete buffers and oversized comparisons", () => {
  const bytes = new Uint8ClampedArray(4);
  for (const [width, height] of [[0, 1], [1.5, 1], [1, NaN], [4_000_001, 1], [2, 1]])
    assert.throws(() => pixelDifferenceSummary(bytes, bytes, width, height), /dimensions rejected/);
  assert.throws(() => pixelDifferenceSummary(bytes, new Uint8ClampedArray(3), 1, 1), /dimensions rejected/);
  assert.throws(() => pixelDifferenceSummary(bytes, bytes, 1, 1, new Uint8ClampedArray(3)), /dimensions rejected/);
});
