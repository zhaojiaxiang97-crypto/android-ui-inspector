// Test tooling only. Every run owns a fresh directory; never uses the user's MCP share.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function parseArgs(args) {
  let resources, candidate;
  for (const value of args) {
    if (value.startsWith("--candidate=") && candidate === undefined) candidate = value.slice(12);
    else if (value.startsWith("--app-resources=") && resources === undefined) resources = value.slice(16);
    else if (!value.startsWith("-") && resources === undefined) resources = value;
    else throw new Error(`Unknown or duplicate argument: ${value}`);
  }
  assert(resources, "An explicit candidate resources directory is required");
  assert(candidate && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(candidate), "A safe --candidate identifier is required");
  return { resources: resolve(resources), candidate };
}
function createEvidence(base, identity) {
  mkdirSync(base, { recursive: true });
  const output = mkdtempSync(join(base, "run-"));
  writeFileSync(join(output, "started.json"), JSON.stringify({ ...identity, startedAt: new Date().toISOString() }, null, 2), { flag: "wx" });
  return output;
}
function writeResult(output, report) {
  writeFileSync(join(output, "result.json"), JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2), { flag: "wx" });
}
function resourceIdentity(resources) {
  const asar = require("@electron/asar"), archive = join(resources, "app.asar");
  asar.uncache(archive);
  const files = {};
  const bytes = name => asar.extractFile(archive, name);
  const core = ["package.json", "dist/index.html", "dist-electron/main.cjs", "dist-electron/preload.cjs", "dist-electron/webp-alpha-worker.cjs"];
  const assets = asar.listPackage(archive).map(name => name.replace(/^[/\\]/, "")).filter(name => /^dist\/assets\/.*\.(js|css)$/.test(name)).sort();
  assert(assets.some(name => name.endsWith(".js")) && assets.some(name => name.endsWith(".css")), "Candidate renderer or production styles missing");
  for (const name of [...core, ...assets]) files[name] = hash(bytes(name));
  for (const [external, internal] of [["cli/android-ui.cjs", "dist-electron/cli.cjs"], ["mcp/server.cjs", "dist-electron/mcp.cjs"]]) {
    files[external] = hash(readFileSync(join(resources, external)));
    // electron-builder moves extraResources out of ASAR; older builders may retain a copy.
    if (asar.listPackage(archive).includes("/" + internal)) {
      files[internal] = hash(bytes(internal));
      assert.equal(files[external], files[internal], `${external} differs from the packaged bundle`);
    }
  }
  const native = [];
  function walk(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.(node|dylib|so(?:\.\d+)*)$/.test(entry.name)) native.push(path);
    }
  }
  walk(join(resources, "app.asar.unpacked"));
  assert(native.some(path => /sharp.*\.node$/.test(path)), "Unpacked sharp native module missing");
  for (const path of native.sort()) files[path.slice(resources.length + 1)] = hash(readFileSync(path));
  // Electron's patched fs treats ASAR as a directory. Hash the physical archive without
  // changing process.noAsar (the renderer and production report harness still need it).
  const physicalRead = process.versions.electron ? require("original-fs").readFileSync : readFileSync;
  const metadata = JSON.parse(bytes("package.json").toString());
  return { resources, archiveSha256: hash(physicalRead(archive)), version: metadata.version,
    ...(metadata.inspectorCandidate ? { candidate: metadata.inspectorCandidate } : {}), files };
}
function verifyUnchanged(before, resources) {
  const after = resourceIdentity(resources);
  assert.deepEqual(after, before, "Candidate resources changed during this check");
  return after;
}
function verifyBuildMatches(identity, project) {
  const compared = [];
  for (const [name, digest] of Object.entries(identity.files)) {
    const source = name === "cli/android-ui.cjs" ? "dist-electron/cli.cjs" : name === "mcp/server.cjs" ? "dist-electron/mcp.cjs" : name;
    if (!/^dist(?:-electron)?\//.test(source)) continue;
    assert.equal(hash(readFileSync(join(project, source))), digest, `Candidate differs from frozen build: ${name}`);
    compared.push(name);
  }
  assert.equal(JSON.parse(readFileSync(join(project, "package.json"))).version, identity.version);
  return compared;
}
module.exports = { hash, parseArgs, createEvidence, writeResult, resourceIdentity, verifyUnchanged, verifyBuildMatches };
