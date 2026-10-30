// Same-process static ABBA gate. This proves pixels, not business performance.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseCapturedViewLayers } from "../../../electron/capture/view-protocol";

const serial = process.argv[2];
assert.ok(serial && /^[\w.-]+$/.test(serial));
const app = "com.androiduiinspector.sample";
const raw = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { timeout: 15000, maxBuffer: 64000000 });
const adb = (...args: string[]) => raw(...args).toString("utf8");
const output = join(import.meta.dirname, "../../../.benchmarks/visible-tree-pixels", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
console.log(output);
const previous = /(?:mResumedActivity:|topResumedActivity=).*?\s([\w.]+\/[\w.$]+)\s/.exec(adb("shell", "dumpsys", "activity", "activities"))?.[1];
const records: any[] = [];
try {
  adb("shell", "am", "force-stop", app);
  adb("shell", "am", "start", "-n", `${app}/.MainActivity`, "--es", "mode", "default");
  await delay(1000);
  for (const guarded of [false, true, true, false]) {
    const nonce = randomBytes(8).toString("hex"), started = performance.now();
    const reply = adb("shell", "content", "call", "--uri", `content://${app}.inspector`, "--method", "capture-visible",
      "--arg", nonce, "--extra", `withTree:b:${guarded}`, "--extra", "geometryFile:b:true");
    const field = (key: string) => new RegExp(`\\b${key}=([^,}\\]]+)`).exec(reply)?.[1];
    const record: any = { guarded, nonce, durationMs: Math.round(performance.now() - started), reply };
    records.push(record);
    writeFileSync(join(output, "attempts.json"), JSON.stringify(records, null, 2));
    assert.equal(field("result"), "ok", reply);
    assert.equal(field("nonce"), nonce);
    const data = raw("exec-out", "run-as", app, "cat", "no_backup/inspector-visible-layers.bin");
    writeFileSync(join(output, `${records.length}.bin`), data);
    assert.equal(data.length, Number(field("bytes")));
    assert.equal(createHash("sha256").update(data).digest("hex"), field("sha256"));
    assert.equal(data.subarray(0, 8).toString("hex"), nonce);
    assert.equal(data.at(-1), 2);
    const layers = parseCapturedViewLayers(data);
    assert.equal(layers.length, Number(field("count")));
    assert.equal(Number(field("selected")), layers.length + Number(field("empty")));
    assert.ok(layers.length > 0);
    assert.equal(new Set(layers.map(layer => layer.name)).size, layers.length);
    if (guarded) {
      const tree = JSON.parse(adb("exec-out", "run-as", app, "cat", `no_backup/inspector-tree-${nonce}.json`));
      assert.equal(tree.visibleTreeGuardVersion, 1);
      assert.equal(tree.root.ref, field("rootRef"));
      assert.equal(tree.processInstance, field("processInstance"));
    }
    // Decode lossless PNG/WebP to RGBA in memory, ignoring encoder/container differences.
    const pixels = JSON.parse(execFileSync("python3", ["-c", `import sys,json,base64,io,hashlib
from PIL import Image
out=[]
for layer in json.load(sys.stdin):
 image=layer.pop('imageDataUrl')
 if image:
  bitmap=Image.open(io.BytesIO(base64.b64decode(image.split(',',1)[1]))).convert('RGBA')
  assert bitmap.size==(layer['width'],layer['height'])
  layer['rgbaSha256']=hashlib.sha256(bitmap.tobytes()).hexdigest()
 else: layer['rgbaSha256']=None
 out.append(layer)
print(json.dumps(sorted(out,key=lambda x:x['name'])))`], { input: JSON.stringify(layers), encoding: "utf8", timeout: 15000, maxBuffer: 5000000 }));
    record.processInstance = field("processInstance"); record.rootRef = field("rootRef");
    record.selected = Number(field("selected")); record.empty = Number(field("empty")); record.pixels = pixels;
    writeFileSync(join(output, "attempts.json"), JSON.stringify(records, null, 2));
    if (records.length > 1) {
      assert.equal(record.processInstance, records[0].processInstance);
      assert.equal(record.rootRef, records[0].rootRef);
      assert.equal(record.selected, records[0].selected);
      assert.equal(record.empty, records[0].empty);
      assert.deepEqual(pixels, records[0].pixels, "static per-ref RGBA or geometry changed");
    }
    console.log(JSON.stringify({ guarded, layers: layers.length, durationMs: record.durationMs }));
    adb("shell", "run-as", app, "rm", "-f", `no_backup/inspector-tree-${nonce}.json`, `no_backup/inspector-geometry-${nonce}.json`);
  }
  writeFileSync(join(output, "summary.json"), JSON.stringify({ passed: true, attempts: records.length, layers: records[0].pixels.length,
    scope: "same-process static sample ABBA RGBA and geometry; not business or cold-start acceptance" }, null, 2));
} catch (error) {
  writeFileSync(join(output, "summary.json"), JSON.stringify({ passed: false, error: String(error) }, null, 2));
  throw error;
} finally {
  if (previous && !previous.startsWith(`${app}/`)) adb("shell", "am", "start", "-n", previous);
}
