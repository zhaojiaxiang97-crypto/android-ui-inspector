// Explicit, read-only preflight. Import/construction never contacts a device or starts a capture.
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
import { verifyLocalQueueBuild } from "./sdk-queue-build";
import { verifyInstalledQueueApk, verifyQueueProcess } from "./sdk-queue-identity";

type ProcessTarget = { serial: string; packageName: string; pid: number; startTicks: string };
export type QueueBootstrapTarget = ProcessTarget & { apkPath: string; aarPath: string };
type Query = Pick<ProcessTarget, "serial" | "packageName" | "pid"> & { sourceSha256: string; nonce: string };
// A resolved execution means exit zero, not that content's Provider operation succeeded.
type Execute = (args: string[], timeoutMs: number, signal: AbortSignal) => Promise<string | { stdout: string; stderr: string }>;
const executeAdb: Execute = async (args, timeout, signal) =>
  await promisify(execFile)("adb", args, { timeout, signal, encoding: "utf8", maxBuffer: 4096 });

function validateProcess(target: Pick<ProcessTarget, "serial" | "packageName" | "pid">) {
  if (!/^[\w.-]+$/.test(target.serial) || !/^[\w]+(?:\.[\w]+)+$/.test(target.packageName)
    || !Number.isSafeInteger(target.pid) || target.pid <= 0) throw Error("Invalid diagnostic identity target");
}

/** The SDK echoes a fresh host challenge, not a caller-supplied or cached instance ID.
 * This is source binding, not cryptographic attestation. Never use it without /proc/APK checks.
 */
export function parseDiagnosticIdentity(reply: string, expected: Pick<Query, "pid" | "sourceSha256" | "nonce">) {
  validateExpectation(expected);
  if (typeof reply !== "string" || Buffer.byteLength(reply) > 4096) throw Error("Diagnostic identity reply too large");
  const match = /^Result: Bundle\[\{([^\r\n]*)\}\]$/.exec(reply.trim());
  if (!match) throw Error("Diagnostic identity unavailable");
  const entries = match[1].split(", ").map(pair => pair.split("="));
  const value = Object.fromEntries(entries);
  if (entries.length !== 6 || entries.some(pair => pair.length !== 2) || Object.keys(value).length !== 6
    || value.result !== "ok" || value.protocol !== "sdk-diagnostic-identity-v1"
    || value.nonce !== expected.nonce || value.sourceSha256 !== expected.sourceSha256
    || value.pid !== String(expected.pid)
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.processInstance))
    throw Error("Diagnostic identity mismatch or unsupported SDK");
  return { processInstance: value.processInstance, pid: expected.pid,
    sourceSha256: value.sourceSha256, sdkVersion: `sdk-source-v1:${value.sourceSha256}` };
}

function validateExpectation(expected: Pick<Query, "pid" | "sourceSha256" | "nonce">) {
  if (!Number.isSafeInteger(expected.pid) || expected.pid <= 0
    || !/^[a-f0-9]{64}$/.test(expected.sourceSha256) || !/^[a-f0-9]{64}$/.test(expected.nonce))
    throw Error("Invalid diagnostic identity expectation");
}

/** One bounded Binder scalar query; no session, forward, tree, image, or retry is created. */
export async function readDiagnosticIdentity(target: Query, signal: AbortSignal, execute: Execute = executeAdb) {
  target = { ...target };
  validateProcess(target);
  validateExpectation(target);
  signal.throwIfAborted();
  const output = await execute(["-s", target.serial, "shell", "content", "call", "--uri",
    `content://${target.packageName}.inspector`, "--method", "read-diagnostic-identity", "--arg", target.nonce,
    "--extra", `pid:s:${target.pid}`], 2000, signal);
  signal.throwIfAborted();
  if (typeof output !== "string" && (!output || typeof output.stdout !== "string" || typeof output.stderr !== "string"))
    throw Error("Invalid diagnostic command reply");
  const stdout = typeof output === "string" ? output : output.stdout;
  const stderr = typeof output === "string" ? undefined : output.stderr;
  try {
    if (stderr !== undefined && Buffer.byteLength(stderr) > 4096) throw Error("Diagnostic stderr too large");
    // AOSP content catches Provider exceptions and prints this line, even when it exits zero.
    // Do not classify all stderr as failure: adb daemon messages may accompany a valid reply.
    if (stderr !== undefined && /^Error while accessing provider:/m.test(stderr))
      throw Error("Diagnostic identity unavailable: content command reported a Provider access error");
    return parseDiagnosticIdentity(stdout, target);
  } catch (error) {
    // Evidence of a completed command, not an inferred timeout/permission/startup cause.
    Object.assign(error as Error, { code: 0, killed: false, signal: null, stdout: stdout.slice(0, 4096),
      ...(stderr === undefined ? {} : { stderr: stderr.slice(0, 4096) }),
      ...(stdout.length > 4096 || (stderr?.length ?? 0) > 4096 ? { outputTruncated: true } : {}) });
    throw error;
  }
}

type Dependencies = {
  verifyLocal?: typeof verifyLocalQueueBuild;
  verifyInstalled?: typeof verifyInstalledQueueApk;
  verifyProcess?: typeof verifyQueueProcess;
  readIdentity?: typeof readDiagnosticIdentity;
};

/** Fresh nonce + single-use entry reject stale replies/replay on the host. The SDK keeps no nonce history.
 * The caller supplies a previously observed real PID/startTicks and trusted build outputs.
 * This returns identity only: starting an observation/capture is a separate explicit action.
 */
export function createQueueIdentityBootstrap(target: QueueBootstrapTarget, dependencies: Dependencies = {}) {
  const pinned = Object.freeze({ ...target });
  validateProcess(pinned);
  if (!/^\d+$/.test(pinned.startTicks) || !isAbsolute(pinned.apkPath) || !isAbsolute(pinned.aarPath))
    throw Error("Known process start and absolute diagnostic artifacts required");
  const verifyLocal = dependencies.verifyLocal ?? verifyLocalQueueBuild;
  const verifyInstalled = dependencies.verifyInstalled ?? verifyInstalledQueueApk;
  const verifyProcess = dependencies.verifyProcess ?? verifyQueueProcess;
  const readIdentity = dependencies.readIdentity ?? readDiagnosticIdentity;
  let used = false;
  return {
    async run(signal: AbortSignal) {
      if (used) throw Error("Diagnostic identity bootstrap already consumed");
      used = true;
      signal.throwIfAborted();
      const build = await verifyLocal(pinned.apkPath, pinned.aarPath, signal);
      signal.throwIfAborted();
      if (![build.apkSha256, build.aarSha256, build.sourceSha256].every(value => /^[a-f0-9]{64}$/.test(value))
        || build.sdkVersion !== `sdk-source-v1:${build.sourceSha256}`) throw Error("Invalid trusted SDK build");
      const before = await verifyInstalled(pinned, build.apkSha256, signal);
      signal.throwIfAborted();
      if (before.apkSha256 !== build.apkSha256 || !before.installedPath)
        throw Error("Installed APK identity mismatch before bootstrap");
      const processBefore = await verifyProcess(pinned, signal);
      signal.throwIfAborted();
      if (processBefore.pid !== pinned.pid || processBefore.startTicks !== pinned.startTicks)
        throw Error("Process identity changed before bootstrap");
      const nonce = randomBytes(32).toString("hex");
      const query = Object.freeze({ serial: pinned.serial, packageName: pinned.packageName, pid: pinned.pid,
        sourceSha256: build.sourceSha256, nonce });
      const identity = await readIdentity(query, signal);
      signal.throwIfAborted();
      if (identity.pid !== pinned.pid || identity.sourceSha256 !== build.sourceSha256
        || identity.sdkVersion !== build.sdkVersion
        || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(identity.processInstance))
        throw Error("Diagnostic identity mismatch");
      const after = await verifyInstalled(pinned, build.apkSha256, signal);
      signal.throwIfAborted();
      if (before.apkSha256 !== build.apkSha256 || after.apkSha256 !== build.apkSha256
        || !before.installedPath || before.installedPath !== after.installedPath)
        throw Error("Installed APK changed during bootstrap");
      const processAfter = await verifyProcess(pinned, signal);
      signal.throwIfAborted();
      if (processAfter.pid !== pinned.pid || processAfter.startTicks !== pinned.startTicks)
        throw Error("Process identity changed after bootstrap");
      return Object.freeze({ ...pinned, ...identity, apkSha256: build.apkSha256,
        aarSha256: build.aarSha256, installedPath: after.installedPath });
    },
  };
}
