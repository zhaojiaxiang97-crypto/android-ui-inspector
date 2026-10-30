// Offline comparison of saved captures only; does not contact or change the phone.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { UiNode, UiSnapshot } from "../shared/types";
const output = resolve(process.argv[2] ?? "");
assert.ok(output.startsWith(resolve(import.meta.dirname, "../.benchmarks/small-page-routes-")), "Saved route comparison directory required");
const load = (route: string) => {
  const snapshot: UiSnapshot = JSON.parse(readFileSync(join(output, `${route}-snapshot.json`), "utf8"));
  const nodes = new Map<string, UiNode>(), pending = snapshot.root ? [snapshot.root] : [];
  while (pending.length) { const node = pending.pop()!; const ref = node.attributes?.["view-ref"];
    if (ref) { assert.ok(!nodes.has(ref), "duplicate View ref"); nodes.set(ref, node); } pending.push(...node.children); }
  return nodes;
};
const decode = (node: UiNode) => {
  const match = /^data:image\/(png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(node.layerImageDataUrl ?? "");
  assert.ok(match, "PNG or WebP image required");
  const image = Buffer.from(match[2], "base64");
  const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", "pipe:0"],
    { input: image, timeout: 5000, encoding: "utf8", maxBuffer: 10000 }));
  const { width, height } = info.streams[0];
  assert.ok(width > 0 && height > 0 && width * height <= 4_000_000);
  const rgba = execFileSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
    { input: image, timeout: 5000, maxBuffer: 16_000_000 });
  assert.equal(rgba.length, width * height * 4); return { width, height, rgba };
};
const before = load("ddms"), after = load("sdk-visible"), rows = [];
for (const ref of new Set([...before.keys(), ...after.keys()])) {
  const a = before.get(ref), b = after.get(ref);
  if (!a || !b) { rows.push({ ref, missingNode: true }); continue; }
  if (!a.layerImageDataUrl && !b.layerImageDataUrl) continue;
  if (!a.layerImageDataUrl || !b.layerImageDataUrl) { rows.push({ ref, missingImage: true }); continue; }
  const x = decode(a), y = decode(b);
  if (x.width !== y.width || x.height !== y.height) { rows.push({ ref, sizeMismatch: true }); continue; }
  let rgbaChanged = 0, alphaChanged = 0, visibleRgbChanged = 0, maxChannelDelta = 0, premultipliedChanged = 0, maxPremultipliedDelta = 0;
  for (let i = 0; i < x.rgba.length; i += 4) {
    let changed = false, rgb = false;
    for (let c = 0; c < 4; c++) {
      const delta = Math.abs(x.rgba[i + c] - y.rgba[i + c]);
      if (delta) { changed = true; if (c < 3) rgb = true; maxChannelDelta = Math.max(maxChannelDelta, delta); }
    }
    if (changed) rgbaChanged++;
    if (x.rgba[i + 3] !== y.rgba[i + 3]) alphaChanged++;
    if (rgb && (x.rgba[i + 3] || y.rgba[i + 3])) visibleRgbChanged++;
    let premultiplied = false;
    for (let c = 0; c < 3; c++) {
      const delta = Math.abs(Math.round(x.rgba[i + c] * x.rgba[i + 3] / 255) - Math.round(y.rgba[i + c] * y.rgba[i + 3] / 255));
      if (delta) premultiplied = true;
      maxPremultipliedDelta = Math.max(maxPremultipliedDelta, delta);
    }
    if (premultiplied) premultipliedChanged++;
  }
  rows.push({ ref, className: a.className, width: x.width, height: x.height, rgbaChanged, alphaChanged, visibleRgbChanged, maxChannelDelta, premultipliedChanged, maxPremultipliedDelta,
    beforeEmpty: a.layerImageEmpty, afterEmpty: b.layerImageEmpty });
}
const report = { rows, pairs: rows.filter(row => "rgbaChanged" in row).length,
  exactPairs: rows.filter(row => row.rgbaChanged === 0).length,
  differences: rows.filter(row => !("rgbaChanged" in row) || row.rgbaChanged !== 0),
  scope: "saved sequential captures, exact decoded RGBA; not same-frame or stable performance acceptance" };
writeFileSync(join(output, "pixel-comparison.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, rows: undefined }));
