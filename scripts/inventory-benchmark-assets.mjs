#!/usr/bin/env node
// Read-only: classify top-level directories by size without opening any private evidence files.
// No deletion, archive, upload, or directory traversal through symlinks.
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length < 1 || args.length > 2)
  throw new Error("Usage: node scripts/inventory-benchmark-assets.mjs /absolute/.benchmarks [private-inventory.json]");
const root = resolve(args[0]);
if (!root.endsWith("/.benchmarks") || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
  throw new Error("Inventory root must be a real .benchmarks directory.");
const entries = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink());
const category = name => {
  if (/(?:^|[-_])(d\d{1,3}|evidence|failure|business|device|acceptance|report|regression|repro)(?:[-_]|$)/i.test(name))
    return "evidence-review-first";
  if (/(?:candidate|maintenance|package|release|build|deploy)/i.test(name)) return "mixed-build-review";
  if (/(?:cache|profile|smoke|render|webp|preview|coordinate)/i.test(name)) return "regenerable-review";
  return "unclassified-review";
};
const result = spawnSync("du", ["-sk", ...entries.map(entry => join(root, entry.name))], {
  encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 120_000,
});
if (result.error || result.status !== 0)
  throw new Error(`du inventory failed: ${result.error?.message ?? (result.stderr ?? "").slice(0, 1000)}`);
const dirs = result.stdout.trim().split("\n").filter(Boolean).map(line => {
  const match = /^(\d+)\s+(.+)$/.exec(line);
  if (!match) throw new Error("Unexpected disk usage format.");
  const name = match[2].slice(root.length + 1);
  if (!entries.some(entry => entry.name === name)) throw new Error("Unexpected directory returned by du.");
  return { name, kib: Number(match[1]), category: category(name), reviewed: false };
}).sort((a, b) => b.kib - a.kib);
const classes = [...new Set(dirs.map(item => item.category))].sort();
const summary = { version: 1, topLevelDirectories: dirs.length,
  totalTopLevelKiB: dirs.reduce((n, item) => n + item.kib, 0),
  byCategory: Object.fromEntries(classes.map(key => [key, dirs.filter(item => item.category === key)
    .reduce((n, item) => n + item.kib, 0)])),
  top15: dirs.slice(0, 15),
  action: "inventory_only_no_deletion",
  retention: "先核验失败证据、哈希清单和引用；需要备份、脱敏及人工复核后才可讨论清理",
};
if (args[1]) {
  const destination = resolve(args[1]);
  writeFileSync(destination, JSON.stringify({ ...summary, directories: dirs }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
console.log(JSON.stringify(summary, null, 2));
