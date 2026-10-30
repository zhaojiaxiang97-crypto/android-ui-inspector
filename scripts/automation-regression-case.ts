import { isDeepStrictEqual } from "node:util";
import { open } from "node:fs/promises";

type CaseHashes = { sample: string; helper: string; boot: string };
type Options = {
  path: string;
  record: Record<string, unknown>;
  run: () => Promise<void>;
  expectedHashes: () => CaseHashes | null;
  readAfterHashes: () => CaseHashes | Promise<CaseHashes>;
  readAnimationScale: () => string | Promise<string>;
};

/** Reserve durable evidence before any case work; preserve failures before propagating them. */
export async function recordRegressionCase(options: Options): Promise<void> {
  let file, runFailed = false, runError: unknown, completeSuccess = false;
  try {
    file = await open(options.path, "wx", 0o600);
    await file.writeFile(JSON.stringify({ ...options.record, caseCompletion: { status: "running", completeSuccess: false } }, null, 2) + "\n");
    await file.sync();
    try { await options.run(); } catch (error) { runFailed = true; runError = error; }
    let afterHashes: CaseHashes | null = null, transitionAnimationScale: string | null = null;
    let identityStatus: "verified" | "mismatch" | "unavailable" = "unavailable";
    let animationStatus: "verified" | "mismatch" | "unavailable" = "unavailable";
    try {
      const expected = options.expectedHashes();
      if (expected) {
        afterHashes = await options.readAfterHashes();
        identityStatus = isDeepStrictEqual(afterHashes, expected) ? "verified" : "mismatch";
      }
    } catch { /* Unknown end identity must never be replaced with the starting identity. */ }
    try {
      transitionAnimationScale = await options.readAnimationScale();
      animationStatus = transitionAnimationScale === "1.0" ? "verified" : "mismatch";
    } catch { /* An independent query failure must not discard the case or identity result. */ }
    const result = options.record.result as { completeSuccess?: unknown } | null;
    completeSuccess = !runFailed && result?.completeSuccess === true && identityStatus === "verified" && animationStatus === "verified";
    const manifest = { ...options.record, afterHashes, transitionAnimationScale,
      caseCompletion: { status: "finished", completeSuccess, runCompleted: !runFailed, runErrorCode: runFailed ? "case_run_failed" : null,
        identityStatus, animationStatus } };
    const contents = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    await file.truncate(0);
    for (let offset = 0; offset < contents.length;) {
      const { bytesWritten } = await file.write(contents, offset, contents.length - offset, offset);
      if (!bytesWritten) throw new Error("case_manifest_short_write");
      offset += bytesWritten;
    }
    await file.sync(); await file.close(); file = undefined;
  } catch (error) {
    throw Object.assign(new Error("case_manifest_write_failed"), { errors: runFailed ? [runError, error] : [error] });
  } finally { if (file) await file.close().catch(() => undefined); }
  if (runFailed) throw runError;
  if (!completeSuccess) throw new Error("case_end_checks_failed");
}
