// Trusted local artifacts plus installed APK hash and runtime reply establish admission.
// The source fingerprint is NOT an AAR binary hash or a cryptographic attestation.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";

type Execute = (command: string, args: string[], signal: AbortSignal) => Promise<string>;
const executeFile: Execute = async (command, args, signal) =>
  (await promisify(execFile)(command, args, { signal, timeout: 2000, maxBuffer: 4096, encoding: "utf8" })).stdout;
export function parseSdkBuildMarker(json: string) {
  if (Buffer.byteLength(json) > 1024) throw Error("SDK build marker too large");
  const value = JSON.parse(json);
  if (!value || Array.isArray(value) || Object.keys(value).length !== 2 || value.protocol !== "sdk-source-v1"
    || typeof value.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceSha256)) throw Error("Invalid SDK build marker");
  return value as { protocol: "sdk-source-v1"; sourceSha256: string };
}
async function digest(path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0 || info.size > 2 * 1024 ** 3) throw Error("Invalid diagnostic artifact");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  signal.throwIfAborted();
  return hash.digest("hex");
}
/** Caller selects trusted build outputs. Reject changed files or duplicate/inconsistent asset contents. */
export async function verifyLocalQueueBuild(apkPath: string, aarPath: string, signal: AbortSignal,
  execute: Execute = executeFile) {
  if (!isAbsolute(apkPath) || !isAbsolute(aarPath)) throw Error("Absolute diagnostic artifact paths required");
  const apkSha256 = await digest(apkPath, signal), aarSha256 = await digest(aarPath, signal);
  const read = async (path: string) => {
    signal.throwIfAborted();
    const value = await execute("unzip", ["-p", path, "assets/inspector-sdk-build.json"], signal);
    signal.throwIfAborted();
    return parseSdkBuildMarker(value);
  };
  const apk = await read(apkPath), aar = await read(aarPath);
  if (apk.sourceSha256 !== aar.sourceSha256) throw Error("APK/SDK source identity mismatch");
  if (await digest(apkPath, signal) !== apkSha256 || await digest(aarPath, signal) !== aarSha256)
    throw Error("Diagnostic artifacts changed during verification");
  return { apkSha256, aarSha256, sourceSha256: apk.sourceSha256, sdkVersion: `sdk-source-v1:${apk.sourceSha256}` };
}

export function parseRuntimeSdkBuild(reply: string, expected: { sourceSha256: string; pid: number; processInstance: string }) {
  if (Buffer.byteLength(reply) > 4096) throw Error("SDK identity reply too large");
  const match = /^Result: Bundle\[\{([^\r\n]*)\}\]$/.exec(reply.trim());
  if (!match) throw Error("SDK identity unavailable");
  const entries = match[1].split(", ").map(pair => pair.split("="));
  const value = Object.fromEntries(entries);
  if (entries.length !== 5 || entries.some(pair => pair.length !== 2) || Object.keys(value).length !== 5
    || value.result !== "ok" || value.protocol !== "sdk-source-v1" || value.sourceSha256 !== expected.sourceSha256
    || !/^[a-f0-9]{64}$/.test(value.sourceSha256) || value.pid !== String(expected.pid)
    || !Number.isSafeInteger(expected.pid) || expected.pid <= 0
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(expected.processInstance)
    || value.processInstance !== expected.processInstance) throw Error("SDK runtime identity mismatch");
  return { sdkVersion: `sdk-source-v1:${value.sourceSha256}`, pid: expected.pid, processInstance: expected.processInstance };
}

export async function readRuntimeSdkBuild(target: { serial: string; packageName: string; sourceSha256: string;
  pid: number; processInstance: string }, signal: AbortSignal, execute: Execute = executeFile) {
  target = { ...target };
  if (!/^[\w.-]+$/.test(target.serial) || !/^[\w]+(?:\.[\w]+)+$/.test(target.packageName)) throw Error("Invalid SDK target");
  // Validate expected values before contacting a device.
  parseRuntimeSdkBuild(`Result: Bundle[{result=ok, protocol=sdk-source-v1, sourceSha256=${target.sourceSha256}, pid=${target.pid}, processInstance=${target.processInstance}}]`, target);
  signal.throwIfAborted();
  const reply = await execute("adb", ["-s", target.serial, "shell", "content", "call", "--uri",
    `content://${target.packageName}.inspector`, "--method", "read-sdk-build", "--extra",
    `processInstance:s:${target.processInstance}`], signal);
  signal.throwIfAborted();
  return parseRuntimeSdkBuild(reply, target);
}
