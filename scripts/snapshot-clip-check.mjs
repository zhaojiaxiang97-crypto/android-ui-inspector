import { readFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { build } from "vite";

const source = process.argv[2];
const branch = process.argv[3];
const groupFile = process.argv[4];
if (!source || process.argv.length > 5 || groupFile && !branch) throw new Error("Usage: bun scripts/snapshot-clip-check.mjs <saved snapshots.json> [branch ID [live-group/group.png]]");
if (groupFile) {
  const manifest = JSON.parse(readFileSync(resolve(groupFile, "../result.json"), "utf8"));
  const bytes = readFileSync(resolve(groupFile));
  if (!manifest.success || manifest.nodeId !== branch || manifest.source !== resolve(source) || manifest.sha256 !== createHash("sha256").update(bytes).digest("hex")) throw new Error("Live group manifest/source/identity/hash rejected");
}
const project = resolve(import.meta.dirname, "..");
const snapshot = JSON.parse(readFileSync(resolve(source), "utf8"))[0]?.snapshot;
if (!snapshot?.root) throw new Error("Saved snapshot has no tree");
const output = join(project, ".benchmarks", "snapshot-clip", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
await build({ configFile: false, root: project, build: { outDir: output, emptyOutDir: false,
  lib: { entry: join(project, "benchmarks/snapshot-clip-check.ts"), name: "SnapshotClip", formats: ["iife"], fileName: () => "checker.js" } } });
const require = createRequire(import.meta.url);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [join(project, "scripts/snapshot-clip-main.cjs"), resolve(source), output, ...(branch ? [branch] : []), ...(groupFile ? [resolve(groupFile)] : [])], { env, stdio: "inherit" });
process.exitCode = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", code => done(code ?? 1)); });
