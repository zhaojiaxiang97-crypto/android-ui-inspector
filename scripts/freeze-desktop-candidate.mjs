// Local release preparation only: freeze dirty public source and record the running package.
// No build, process stop, profile mutation or phone command.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: project, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const paths = [...new Set(git("ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0"))].filter(name =>
  /^(src|electron|shared|tests|scripts|benchmarks|build|public|android|docs|\.github)\//.test(name)
  || /^(package\.json|bun\.lock|tsconfig(?:\.node)?\.json|vite\.config\.ts|index\.html|README\.md|\.gitignore)$/.test(name))
  .filter(name => !/(^|\/)(node_modules|build\/outputs|\.gradle|\.e2e|\.env(?:\..*)?|local\.properties|credentials|secrets)(\/|$)|\.(apk|aab|jks|keystore|pem|key)$/.test(name))
  .filter(name => existsSync(join(project, name)) && lstatSync(join(project, name)).isFile()).sort();
const sources = paths.map(path => ({ path, sha256: hash(readFileSync(join(project, path))) }));
const sourceDigest = hash(JSON.stringify(sources));
const candidate = `diagnosis-handoff-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${sourceDigest.slice(0, 8)}`;
const base = join(project, ".benchmarks", "desktop-candidates"); mkdirSync(base, { recursive: true });
const output = mkdtempSync(join(base, candidate + "-"));
for (const { path } of sources) {
  const destination = join(output, "source", path); mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(project, path), destination);
}
// The built App carries its exact candidate ID; the overlay is recorded separately from the original source hashes.
const frozenPackagePath = join(output, "source", "package.json");
const originalPackageBytes = readFileSync(frozenPackagePath);
const frozenPackage = JSON.parse(originalPackageBytes.toString("utf8"));
if (frozenPackage.inspectorCandidate !== undefined) throw new Error("源码已有候选身份，不能重复冻结。");
frozenPackage.inspectorCandidate = candidate;
const stampedPackageBytes = Buffer.from(JSON.stringify(frozenPackage, null, 2) + "\n");
writeFileSync(frozenPackagePath, stampedPackageBytes);
const buildOverrides = { "package.json": { originalSha256: hash(originalPackageBytes), stampedSha256: hash(stampedPackageBytes) } };
const buildSources = sources.map(entry => entry.path === "package.json"
  ? { ...entry, sha256: buildOverrides["package.json"].stampedSha256 } : entry);
const buildSourceDigest = hash(JSON.stringify(buildSources));
const profile = join(homedir(), "Library", "Application Support", "android-ui-inspector");
const liveResources = resolve(project, "release/mac-arm64/Android UI Inspector.app/Contents/Resources");
const oldPaths = [join(liveResources, "app.asar"), join(liveResources, "cli/android-ui.cjs"), join(liveResources, "mcp/server.cjs"),
  ...["Preferences", "Local State", "snapshots.json"].map(name => join(profile, name))];
const oldRecords = oldPaths.map(path => ({ path, exists: existsSync(path), sha256: existsSync(path) ? hash(readFileSync(path)) : null }));
const run = command => execFileSync(command, ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
const manifest = { candidate, sourceDigest, sources, buildSourceDigest, buildOverrides, sourceSnapshot: join(output, "source"), output,
  capturedAt: new Date().toISOString(), baseCommit: git("rev-parse", "HEAD").trim(),
  dirtyStatus: git("status", "--porcelain=v1", "--untracked-files=all"),
  environment: { node: process.version, bun: run("bun"), platform: process.platform, arch: process.arch,
    electron: JSON.parse(readFileSync(join(project, "node_modules/electron/package.json"))).version,
    dependencies: Object.fromEntries(["electron-builder", "vite", "typescript", "react", "sharp"].map(name =>
      [name, JSON.parse(readFileSync(join(project, "node_modules", name, "package.json"))).version])) },
  oldRecords, profile, phoneOperations: 0, installedAcceptance: false };
writeFileSync(join(output, "candidate.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
console.log(JSON.stringify({ candidate, output, sourceDigest, sourceFiles: sources.length }));
