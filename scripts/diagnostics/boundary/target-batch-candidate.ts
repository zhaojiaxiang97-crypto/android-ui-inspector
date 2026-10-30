/** Isolated transport candidate. No default executor, CLI, production imports or device access on import. */
import { randomUUID } from "node:crypto";
import type { DisplayFrame } from "../../../shared/types";
import type { CommandResult, runDeviceAdb } from "../../../electron/device/runtime";
import { checkedForegroundTarget, createDebugFocusReader, ForegroundUnavailableError } from "../../../electron/device/target";
import { withCommandSignal } from "../../../electron/device/command-context";

export const TARGET_BATCH_STREAM_LIMIT = 2 * 1024 * 1024;
export const TARGET_BATCH_LIMIT = 4 * TARGET_BATCH_STREAM_LIMIT + 512;
export type TargetBatchRequest = { requestId: string; script: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export class TargetBatchProtocolError extends Error {
  constructor() { super("窗口查询批次缺失、截断、超限或身份不匹配。"); this.name = "TargetBatchProtocolError"; }
}

export function createTargetBatchRequest(packageName: string): TargetBatchRequest {
  if (!/^[\w]+(?:\.[\w]+)+$/.test(packageName)) throw new Error("授权 App 包名无效。");
  const requestId = randomUUID();
  // Only the two already-parallel target reads are bundled. Display must never delay the later focus read.
  const script = `umask 077
set -f
work=$(mktemp -d "\${TMPDIR:-/data/local/tmp}/inspector-target.XXXXXXXX") || exit 120
activity_pid=
debug_pid=
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  for pid in "$activity_pid" "$debug_pid"; do
    if [ -n "$pid" ]; then kill -KILL "$pid" 2>/dev/null || :; fi
  done
  for pid in "$activity_pid" "$debug_pid"; do
    if [ -n "$pid" ]; then wait "$pid" 2>/dev/null || :; fi
  done
  rm -rf "$work" || exit 124
  exit "$status"
}
trap cleanup EXIT
trap 'exit 125' HUP INT TERM
dumpsys activity activities >"$work/activity.out" 2>"$work/activity.err" &
activity_pid=$!
run-as '${packageName}' id >"$work/debug.out" 2>"$work/debug.err" &
debug_pid=$!
if wait "$activity_pid"; then activity_code=0; else activity_code=$?; fi
activity_pid=
if wait "$debug_pid"; then debug_code=0; else debug_code=$?; fi
debug_pid=
emit() {
  out=$(wc -c <"$work/$1.out") || return 121
  err=$(wc -c <"$work/$1.err") || return 121
  out=$((out)); err=$((err))
  [ "$out" -le ${TARGET_BATCH_STREAM_LIMIT} ] && [ "$err" -le ${TARGET_BATCH_STREAM_LIMIT} ] || return 122
  printf '%s %s %s %s\n' "$1" "$2" "$out" "$err" || return 123
  cat "$work/$1.out" "$work/$1.err" || return 123
  printf '\n' || return 123
}
printf 'INSPECTOR_TARGET_V1 ${requestId}\n' || exit 123
emit activity "$activity_code" || exit $?
emit debug "$debug_code" || exit $?
printf 'END ${requestId}\n' || exit 123
`;
  return { requestId, script };
}

export function decodeTargetBatch(reply: CommandResult, requestId: string) {
  const fail = (): never => { throw new TargetBatchProtocolError(); };
  if (!uuid.test(requestId) || reply.code !== 0 || reply.stderr || reply.stdout.length > TARGET_BATCH_LIMIT) fail();
  let offset = 0;
  const line = () => {
    const end = reply.stdout.indexOf(10, offset);
    if (end < offset || end - offset > 128) return fail();
    const bytes = reply.stdout.subarray(offset, end);
    if (bytes.some(byte => byte < 32 || byte > 126)) return fail();
    const value = bytes.toString("ascii"); offset = end + 1; return value;
  };
  if (line() !== `INSPECTOR_TARGET_V1 ${requestId}`) fail();
  const read = (name: string): CommandResult => {
    const header = line().match(new RegExp(`^${name} (0|[1-9][0-9]{0,2}) (0|[1-9][0-9]{0,7}) (0|[1-9][0-9]{0,7})$`));
    if (!header) return fail();
    const [code, out, err] = header.slice(1).map(Number);
    if (code > 255 || out > TARGET_BATCH_STREAM_LIMIT || err > TARGET_BATCH_STREAM_LIMIT || out + err > reply.stdout.length - offset) fail();
    const stdout = Buffer.from(reply.stdout.subarray(offset, offset + out)); offset += out;
    const stderr = reply.stdout.toString("utf8", offset, offset + err); offset += err;
    if (reply.stdout[offset++] !== 10) fail();
    return { code, stdout, stderr };
  };
  const activity = read("activity"), debug = read("debug");
  if (line() !== `END ${requestId}` || offset !== reply.stdout.length) fail();
  return { activity, debug };
}

export function createTargetBatchBoundary(deps: {
  batch(adbPath: string, serial: string, request: TargetBatchRequest, signal: AbortSignal): Promise<CommandResult>;
  command: typeof runDeviceAdb;
  frame(adbPath: string, serial: string): Promise<DisplayFrame | null>;
}) {
  const focus = createDebugFocusReader(deps.command); // Original query-shape cache; never caches a focus value.
  return (adbPath: string, serial: string, packageName: string, signal: AbortSignal) => withCommandSignal(signal, async () => {
    const target = async () => {
      signal.throwIfAborted();
      const request = createTargetBatchRequest(packageName);
      let raw: CommandResult;
      try { raw = await deps.batch(adbPath, serial, request, signal); }
      catch { signal.throwIfAborted(); throw new ForegroundUnavailableError("query-failed"); }
      signal.throwIfAborted();
      const { activity, debug } = decodeTargetBatch(raw, request.requestId);
      const selected = checkedForegroundTarget(activity, packageName);
      if (debug.code !== 0) throw new Error(`仅支持 Debug App：${selected.packageName} 不可调试。`);
      const current = await focus(adbPath, serial);
      if (current.packageName !== selected.packageName) throw new Error("焦点窗口不属于授权 App；请关闭系统弹窗后重试。");
      return { ...selected, windowId: current.id };
    };
    const [selected, frame] = await Promise.allSettled([target(), deps.frame(adbPath, serial)]);
    signal.throwIfAborted();
    if (selected.status === "rejected") throw selected.reason;
    if (frame.status === "rejected") throw frame.reason;
    return { target: selected.value, frame: frame.value };
  });
}
