// Offline diagnostics only. Exact equality remains the acceptance criterion.
export function pixelDifferenceSummary(actual: Uint8ClampedArray, expected: Uint8ClampedArray,
  width: number, height: number, parentOnly?: Uint8ClampedArray) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
      || width * height > 4_000_000 || actual.length !== width * height * 4
      || expected.length !== actual.length || parentOnly && parentOnly.length !== actual.length)
    throw new Error("Pixel diagnostic dimensions rejected");
  let mismatchedPixels = 0, maxChannelDelta = 0, alphaMismatches = 0;
  let withChildContribution = 0, withoutChildContribution = 0;
  let left = width, top = height, right = -1, bottom = -1;
  const signedChannelDeltas: Record<string, number> = {};
  const samples: Array<{ x: number; y: number; actual: number[]; expected: number[] }> = [];
  for (let i = 0; i < actual.length; i += 4) {
    let mismatch = false;
    for (let c = 0; c < 4; c++) {
      const delta = actual[i + c] - expected[i + c];
      if (!delta) continue;
      mismatch = true;
      const key = `${"RGBA"[c]}:${delta}`;
      signedChannelDeltas[key] = (signedChannelDeltas[key] ?? 0) + 1;
      maxChannelDelta = Math.max(maxChannelDelta, Math.abs(delta));
    }
    if (!mismatch) continue;
    mismatchedPixels++;
    if (actual[i + 3] !== expected[i + 3]) alphaMismatches++;
    const x = (i / 4) % width, y = Math.floor(i / 4 / width);
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    if (parentOnly) {
      if ([0, 1, 2, 3].some(c => expected[i + c] !== parentOnly[i + c])) withChildContribution++;
      else withoutChildContribution++;
    }
    if (samples.length < 8) samples.push({ x, y, actual: [...actual.slice(i, i + 4)], expected: [...expected.slice(i, i + 4)] });
  }
  return { pixels: width * height, mismatchedPixels, maxChannelDelta, alphaMismatches, signedChannelDeltas,
    bounds: mismatchedPixels ? { left, top, right: right + 1, bottom: bottom + 1 } : null, samples,
    ...(parentOnly ? { withChildContribution, withoutChildContribution } : {}) };
}
