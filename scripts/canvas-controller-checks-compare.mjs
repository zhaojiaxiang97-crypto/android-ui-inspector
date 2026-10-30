import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import sharp from "sharp";

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) throw new Error("Usage: node scripts/canvas-controller-checks-compare.mjs BASELINE_RESULT FINAL_RESULT");
const before = JSON.parse(readFileSync(beforePath, "utf8")), after = JSON.parse(readFileSync(afterPath, "utf8"));
// Render counters and generated texture identities are observations, not geometry.
const volatile = new Set(["layerGeometryRevision", "layerRenderVersion", "layerTextureIdentity", "layerCommittedNativeTextures"]);
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !volatile.has(key)).map(([key, item]) => [key, stable(item)]));
  return value;
}
function differences(left, right, path = "") {
  if (typeof left === "number" && typeof right === "number" && Math.abs(left - right) <= 1e-6) return [];
  if (left && right && typeof left === "object" && typeof right === "object") return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap(key => differences(left[key], right[key], `${path}.${key}`));
  return left === right ? [] : [{ path, before: left, after: right }];
}
const key = run => `${run.width}-${run.height}-${run.zoom}`, runs = [];
for (const initial of before.results) {
  const final = after.results.find(run => key(run) === key(initial));
  if (!final) { runs.push({ run: key(initial), missing: true }); continue; }
  const geometryDifferences = differences(stable(initial.observations.baseline), stable(final.observations.baseline));
  const imageName = `${key(initial)}-fixed-scene.png`;
  const [{ data: a, info: ai }, { data: b, info: bi }] = await Promise.all([
    sharp(join(dirname(beforePath), imageName)).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(join(dirname(afterPath), imageName)).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  let changedPixels = 0, changedPixelsAbove2 = 0, maxChannelDifference = 0;
  const sameSize = ai.width === bi.width && ai.height === bi.height;
  if (sameSize) for (let i = 0; i < a.length; i += 4) {
    let changed = false, above2 = false;
    for (let channel = 0; channel < 4; channel++) { const delta = Math.abs(a[i + channel] - b[i + channel]); changed ||= delta !== 0; above2 ||= delta > 2; maxChannelDifference = Math.max(maxChannelDifference, delta); }
    if (changed) changedPixels++;
    if (above2) changedPixelsAbove2++;
  }
  runs.push({ run: key(initial), geometryDifferences, screenshot: { sameSize, changedPixels: sameSize ? changedPixels : null,
    changedPixelsAbove2: sameSize ? changedPixelsAbove2 : null, totalPixels: ai.width * ai.height, maxChannelDifference, exact: sameSize && changedPixels === 0 } });
}
const extraRuns = after.results.map(key).filter(value => !before.results.some(run => key(run) === value));
const geometryMatches = runs.every(run => !run.missing && run.geometryDifferences.length === 0) && extraRuns.length === 0;
console.log(JSON.stringify({ geometryMatches, screenshotsMatch: runs.every(run => run.screenshot?.exact), extraRuns, runs }, null, 2));
process.exitCode = geometryMatches ? 0 : 1;
