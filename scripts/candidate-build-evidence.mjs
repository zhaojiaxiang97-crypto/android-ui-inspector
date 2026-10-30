#!/usr/bin/env node
// Tie an immutable source snapshot to locally-built desktop bundles and the two
// verified Android outputs. Never signs, installs, uploads or approves release.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 3) throw new Error("Usage: node scripts/candidate-build-evidence.mjs CANDIDATE_JSON HELPER_JSON SDK_JSON");
const json = path => JSON.parse(readFileSync(path, "utf8"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const candidateFile = resolve(args[0]);
const candidate = json(candidateFile), sourceRoot = resolve(candidate.sourceSnapshot);
if (!isAbsolute(candidate.sourceSnapshot) || !candidateFile.includes("/.benchmarks/desktop-candidates/")
  || !candidateFile.endsWith("/candidate.json") || !sourceRoot.startsWith(dirname(candidateFile) + "/")
  || !Array.isArray(candidate.sources) || candidate.sources.length < 1
  || candidate.sourceDigest !== hash(JSON.stringify(candidate.sources)))
  throw new Error("Candidate manifest or source digest is inconsistent.");

for (const file of candidate.sources) {
  if (typeof file.path !== "string" || file.path.startsWith("/") || file.path.split("/").includes("..")
    || !/^[a-z0-9_.-]/i.test(file.path))
    throw new Error("Invalid candidate source path.");
  const sourceBytes = readFileSync(join(sourceRoot, file.path));
  if (hash(sourceBytes) !== file.sha256 || hash(readFileSync(join(root, file.path))) !== file.sha256)
    throw new Error("Candidate source no longer matches the working tree.");
}

const output = path => {
  const bytes = readFileSync(join(root, path));
  if (bytes.length < 100) throw new Error("Missing product build artifact: " + path);
  return { path, bytes: bytes.length, sha256: hash(bytes) };
};
const desktop = ["dist/index.html", "dist-electron/main.cjs", "dist-electron/preload.cjs",
  "dist-electron/cli.cjs", "dist-electron/mcp.cjs"].map(output);
const helper = json(args[1]);
if (helper.version !== 1 || helper.installedOrDeviceVerified !== false ||
  typeof helper.apkRelativePath !== "string" || !helper.apkRelativePath.startsWith("app/build/outputs/apk/"))
  throw new Error("Helper build verification is invalid.");
const helperPath = resolve(dirname(args[1]), helper.apkRelativePath);
if (hash(readFileSync(helperPath)) !== helper.apkSha256 ||
  hash(readFileSync(join(dirname(args[1]), "source-manifest.json"))) !== helper.sourceManifestSha256)
  throw new Error("Helper build bytes do not match the verification manifest.");

const sdk = json(args[2]);
if (sdk.version !== 1 || sdk.installedOrDeviceVerified !== false || !Array.isArray(sdk.artifacts)
  || sdk.artifacts.length !== 3) throw new Error("Android SDK build verification is invalid.");
for (const artifact of sdk.artifacts) {
  if (!artifact.path.startsWith("android/") || artifact.path.split("/").includes("..")
    || hash(readFileSync(join(root, artifact.path))) !== artifact.sha256)
    throw new Error("Android SDK build bytes do not match the verification manifest.");
}
const evidence = { version: 1, candidate: candidate.candidate, sourceDigest: candidate.sourceDigest,
  baseCommit: candidate.baseCommit, sourceCount: candidate.sources.length,
  desktop, helper: { upstreamCommit: helper.helperCommit, sourceManifestSha256: helper.sourceManifestSha256,
    apkSha256: helper.apkSha256, apkBytes: helper.apkBytes, protocolVersion: "observation-v1" },
  android: sdk.artifacts, liveInstalledDesktop: "not-verified",
  liveInstalledHelper: "not-verified", helperPairing: "not-verified",
  realDeviceRegression: "pending", deployment: "not-authorized-by-this-report" };
writeFileSync(join(dirname(candidateFile), "build-evidence.json"), JSON.stringify(evidence, null, 2) + "\n",
  { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ candidate: evidence.candidate, sourceDigest: evidence.sourceDigest,
  sourceCount: evidence.sourceCount, desktopBundles: desktop.length, helperApkSha256: helper.apkSha256,
  androidArtifacts: sdk.artifacts.length, report: relative(root, join(dirname(candidateFile), "build-evidence.json")),
  realDeviceRegression: evidence.realDeviceRegression }));
