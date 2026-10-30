export const INPUT_INJECTION_DIAGNOSTIC_LIMITS = { maxOutputBytes: 64 * 1024, maxWindowMs: 10_000 } as const;
const markerPrefix = "__AUI_INPUT_";
const noncePattern = /^[a-f0-9]{32}$/;
const maxPid = 0x7fffffff;

export type InputInjectionMarker = { stdout: string; remotePid: number; systemServerPid: number; deviceEpochMs: number };
export type InputInjectionLogContext = {
  remotePid: number; systemServerPid: number; deviceStartedAt: number; deviceFinishedAt: number;
};
export type InputInjectionLogState = "rejected" | "not_observed" | "unavailable";

const validNonce = (value: string) => typeof value === "string" && value.length === 32 && noncePattern.test(value);
const validPid = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= maxPid;
const validEpoch = (value: number) => Number.isSafeInteger(value) && value >= 1_000_000_000_000 && value <= 9_999_999_999_999;
const boundedOutput = (value: string) => typeof value === "string" && value.length <= INPUT_INJECTION_DIAGNOSTIC_LIMITS.maxOutputBytes
  && Buffer.byteLength(value, "utf8") <= INPUT_INJECTION_DIAGNOSTIC_LIMITS.maxOutputBytes && !value.includes("\0");
const canonicalInteger = (value: string, minimum: number, maximum: number) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && String(number) === value && number >= minimum && number <= maximum;
};
const coordinate = (value: string) => canonicalInteger(value, 0, 100_000);

export function inputInjectionRoute(sdk: string): "tracked" | "legacy" {
  if (!canonicalInteger(sdk, 1, 1000)) throw new Error("无法确认 Android 系统版本，未执行输入。");
  return Number(sdk) >= 31 ? "tracked" : "legacy";
}

function validInputArgs(args: readonly string[]) {
  if (!Array.isArray(args) || ![4, 6, 9].includes(args.length) || !Array.from(args).every(value => typeof value === "string" && value.length <= 12)) return false;
  if (args.length === 4 && args.every((value, index) => value === ["-d", "0", "keyevent", "KEYCODE_BACK"][index])) return true;
  if (args[0] !== "touchscreen" || args[1] !== "-d" || args[2] !== "0") return false;
  if (args.length === 6 && args[3] === "tap") return args.slice(4).every(coordinate);
  if (args.length !== 9 || args[3] !== "swipe" || !args.slice(4, 8).every(coordinate)) return false;
  return canonicalInteger(args[8], 150, 1000)
    && (args[4] !== args[6] || args[5] !== args[7]);
}

function markerScript(nonce: string): string[] {
  if (!validNonce(nonce)) throw new Error("输入诊断的随机标记无效。");
  return [
    "aui_epoch_ms=$(/system/bin/date +%s%3N) || exit 125",
    "case \"$aui_epoch_ms\" in ''|0*|*[!0-9]*) exit 125;; esac",
    "[ \"${#aui_epoch_ms}\" -eq 13 ] || exit 125",
    "aui_system_pid=$(/system/bin/pidof system_server) || exit 125",
    "case \"$aui_system_pid\" in ''|0*|*[!0-9]*) exit 125;; esac",
    "[ \"${#aui_system_pid}\" -le 10 ] && [ \"$aui_system_pid\" -le 2147483647 ] || exit 125",
    `printf '${markerPrefix}${nonce}__:%s:%s:%s\\n' \"$$\" \"$aui_system_pid\" \"$aui_epoch_ms\" || exit 125`,
  ];
}

/** One fixed remote script for adb shell. Only a nonce and validated input arguments vary. */
export function buildInputInjectionCommand(args: readonly string[], nonce: string): string {
  if (!validInputArgs(args)) throw new Error("输入诊断的操作参数无效。");
  return [...markerScript(nonce), `exec /system/bin/cmd input ${args.join(" ")}`].join("; ");
}

export function buildInputInjectionLogCommand(marker: Pick<InputInjectionMarker, "remotePid" | "systemServerPid" | "deviceEpochMs">, nonce: string): string {
  if (!marker || !validPid(marker.remotePid) || !validPid(marker.systemServerPid) || !validEpoch(marker.deviceEpochMs))
    throw new Error("输入诊断的设备身份或起点时间无效。");
  const epoch = `${Math.floor(marker.deviceEpochMs / 1000)}.${String(marker.deviceEpochMs % 1000).padStart(3, "0")}`;
  return [...markerScript(nonce), `exec /system/bin/logcat -d -b system -v epoch -v uid --uid=1000 --pid=${marker.systemServerPid} -T ${epoch} -s InputManager:W '*:S'`].join("; ");
}

/** Strip exactly one matching initial marker; preserve all remaining output for the original classifier. */
export function parseInputInjectionMarker(stdout: string, nonce: string): InputInjectionMarker | null {
  if (!validNonce(nonce) || !boundedOutput(stdout)) return null;
  const end = stdout.indexOf("\n");
  if (end < 0) return null;
  const line = stdout.slice(0, end).replace(/\r$/, "");
  const match = new RegExp(`^${markerPrefix}${nonce}__:([1-9]\\d{0,9}):([1-9]\\d{0,9}):([1-9]\\d{12})$`).exec(line);
  if (!match || match[0] !== line) return null;
  const remotePid = Number(match[1]), systemServerPid = Number(match[2]), deviceEpochMs = Number(match[3]);
  const remainder = stdout.slice(end + 1);
  if (!validPid(remotePid) || !validPid(systemServerPid) || !validEpoch(deviceEpochMs) || remainder.includes(markerPrefix)) return null;
  return { stdout: remainder, remotePid, systemServerPid, deviceEpochMs };
}

/** Validate the complete reply before trusting a system_server/UID 1000 rejection event. */
export function inspectInputInjectionLog(logText: string, context: InputInjectionLogContext): InputInjectionLogState {
  if (!boundedOutput(logText) || !context || !validPid(context.remotePid) || !validPid(context.systemServerPid)
    || !validEpoch(context.deviceStartedAt) || !validEpoch(context.deviceFinishedAt)
    || context.deviceFinishedAt < context.deviceStartedAt
    || context.deviceFinishedAt - context.deviceStartedAt > INPUT_INJECTION_DIAGNOSTIC_LIMITS.maxWindowMs) return "unavailable";
  const header = /^[ \t]*([1-9]\d{9})\.(\d{3})[ \t]+([1-9]\d{0,9})[ \t]+([1-9]\d{0,9})[ \t]+([1-9]\d{0,9})[ \t]+[WEF][ \t]+InputManager[ \t]*:[ \t]+(.+)$/;
  const rejection = /^Input event injection from pid ([1-9]\d{0,9}) (?:failed|timed out)\.$/;
  let rejected = false;
  for (const line of logText.split(/\r?\n/)) {
    if (/^[ \t]*(?![\s\S])/.test(line) || /^[ \t]*--------- beginning of system(?![\s\S])/.test(line)) continue;
    const match = header.exec(line);
    if (!match || match[0] !== line || match[3] !== "1000" || Number(match[4]) !== context.systemServerPid || !validPid(Number(match[5]))) return "unavailable";
    const deviceEpochMs = Number(match[1]) * 1000 + Number(match[2]);
    const message = rejection.exec(match[6]);
    if (message && message[0] === match[6] && Number(message[1]) === context.remotePid
      && deviceEpochMs >= context.deviceStartedAt && deviceEpochMs <= context.deviceFinishedAt) rejected = true;
  }
  return rejected ? "rejected" : "not_observed";
}
