import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { captureViewGroupImage } from "../electron/capture/refresh";
import { createProviderSessionPool } from "../electron/sdk/provider-session";
import type { UiSnapshot } from "../shared/types";

// One production group request against an existing snapshot. No full capture,
// navigation, installation, restart, alternate capture path, or outer retry.
const [source, nodeId] = process.argv.slice(2);
if (!source || !nodeId || process.argv.length !== 4 || !/^0(?:\/\d+)*$/.test(nodeId))
  throw new Error("Usage: bun scripts/live-group-probe.ts <saved snapshots.json> <node ID>");
const snapshot: UiSnapshot = JSON.parse(readFileSync(resolve(source), "utf8"))[0]?.snapshot;
if (!snapshot?.root || snapshot.inspectionSource !== "debug-hybrid") throw new Error("A saved hybrid snapshot is required");
const output = join(import.meta.dirname, "..", ".benchmarks", "live-group", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
const started = performance.now();
const report: Record<string, unknown> = { source: resolve(source), nodeId, savedPid: snapshot.root.attributes?.["debug-process-id"], success: false };
console.log(`Live group output: ${output}`);
const provider = createProviderSessionPool();
try {
  const group = await captureViewGroupImage(provider, snapshot.serial, snapshot, nodeId, AbortSignal.timeout(25_000));
  report.durationMs = Math.round(performance.now() - started);
  if (!group) {
    report.error = "Production group capture rejected or returned no image; no fallback or retry";
    process.exitCode = 1;
  } else {
    const pixels = Buffer.from(group.dataUrl.replace(/^data:image\/png;base64,/, ""), "base64");
    writeFileSync(join(output, "group.png"), pixels);
    report.success = true;
    report.size = group.size;
    report.capturedAt = group.capturedAt;
    report.sha256 = createHash("sha256").update(pixels).digest("hex");
    report.bytes = pixels.length;
  }
} catch (error) {
  report.durationMs = Math.round(performance.now() - started);
  report.error = String(error); process.exitCode = 1;
} finally {
  await provider.dispose();
  writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
