import { performance } from "node:perf_hooks";

export type StartupCommandEvidence = {
  command: string[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "completed" | "failed";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  errorCode: string | null;
};

/** Save the existing launch command's response, including failures; no extra device queries. */
export function recordStartupCommand(
  command: string[], execute: () => Buffer | { stdout: Buffer; stderr: Buffer }, save: (record: StartupCommandEvidence) => void,
) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const evidence = (stdout: string, failure?: unknown, stderr = ""): StartupCommandEvidence => {
    const error = failure as { stdout?: Buffer; stderr?: Buffer; status?: number; signal?: string; code?: string } | undefined;
    return { command: [...command], startedAt, endedAt: new Date().toISOString(),
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      status: error ? "failed" : "completed", stdout: error?.stdout?.toString("utf8") ?? stdout,
      stderr: error?.stderr?.toString("utf8") ?? stderr, exitCode: error ? error.status ?? null : 0,
      signal: error?.signal ?? null, errorCode: error?.code ?? null };
  };
  let output: Buffer | { stdout: Buffer; stderr: Buffer };
  try { output = execute(); }
  catch (error) { save(evidence("", error)); throw error; }
  save(evidence(Buffer.isBuffer(output) ? output.toString("utf8") : output.stdout.toString("utf8"), undefined,
    Buffer.isBuffer(output) ? "" : output.stderr.toString("utf8")));
  return output;
}
