import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { inspectDevice, probeAdb } from "../electron/adb";
import { assessCaptureGeometry } from "../shared/screen-coordinates";

const output = resolve(".benchmarks", "capture-coordinates", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const probe = await probeAdb();
const device = probe.devices.find(value => value.state === "device");
assert.ok(device, "No authorized device");
const snapshot = await inspectDevice(device.serial);
// Raw phone data remains in ignored local diagnostics, never checked-in fixtures.
await writeFile(join(output, "snapshot.json"), JSON.stringify(snapshot, null, 2), "utf8");
const report = { generatedAt: new Date().toISOString(), model: device.model, output, error: snapshot.error, warning: snapshot.warning, nodeCount: snapshot.nodeCount, xmlSize: snapshot.xmlSize, geometry: snapshot.captureGeometry, assessment: assessCaptureGeometry(snapshot.captureGeometry), expectedOrientation: process.argv.includes("--expect-landscape") ? "landscape" : "any" };
await writeFile(join(output, "result.json"), JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
assert.equal(snapshot.error, null); assert.ok(snapshot.root); assert.ok(snapshot.screenshotDataUrl);
assert.equal(report.assessment.status, "checked");
if (process.argv.includes("--expect-landscape")) assert.ok(snapshot.captureGeometry!.screenshotSize.width > snapshot.captureGeometry!.screenshotSize.height, "The captured display was not landscape");
