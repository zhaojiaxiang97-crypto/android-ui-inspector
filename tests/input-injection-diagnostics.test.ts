import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { buildInputInjectionCommand, buildInputInjectionLogCommand, inspectInputInjectionLog,
  INPUT_INJECTION_DIAGNOSTIC_LIMITS, inputInjectionRoute, parseInputInjectionMarker, type InputInjectionLogContext } from "../electron/device/input-injection-diagnostics";

const nonce = "0123456789abcdef0123456789abcdef";
const epoch = 1_792_156_358_155;
const marker = { remotePid: 22121, systemServerPid: 1582, deviceEpochMs: epoch };
const prefix = `__AUI_INPUT_${nonce}__`;
const markerLine = (pid = "22121", server = "1582", time = String(epoch)) => `${prefix}:${pid}:${server}:${time}\n`;
const context: InputInjectionLogContext = { remotePid: marker.remotePid, systemServerPid: marker.systemServerPid,
  deviceStartedAt: epoch - 1000, deviceFinishedAt: epoch + 1000 };
const logLine = (time = "1792156358.155", uid = "1000", server = "1582", pid = "22121", ending = "failed.") =>
  `         ${time}  ${uid}  ${server}  2851 W InputManager: Input event injection from pid ${pid} ${ending}`;

test("input routing preserves Android 11 and earlier without sending a trial input", () => {
  for (const sdk of ["23", "29", "30"]) assert.equal(inputInjectionRoute(sdk), "legacy");
  for (const sdk of ["31", "34", "36"]) assert.equal(inputInjectionRoute(sdk), "tracked");
  for (const sdk of ["", "0", "030", "30\n", "30.0", "unknown", "1001"]) assert.throws(() => inputInjectionRoute(sdk));
});

test("the input builder accepts only the three canonical existing input forms and preserves the exec PID", () => {
  for (const args of [["-d", "0", "keyevent", "KEYCODE_BACK"], ["touchscreen", "-d", "0", "tap", "0", "100000"],
    ["touchscreen", "-d", "0", "swipe", "1", "2", "3", "4", "150"],
    ["touchscreen", "-d", "0", "swipe", "1", "2", "1", "3", "1000"]]) {
    const script = buildInputInjectionCommand(args, nonce);
    assert.ok(script.endsWith(`exec /system/bin/cmd input ${args.join(" ")}`));
    assert.ok(script.includes('"$$"')); assert.ok(script.includes("/system/bin/date +%s%3N"));
    assert.ok(script.includes("/system/bin/pidof system_server"));
    assert.ok(!script.includes("exec input")); assert.ok(!script.includes("sh -c"));
    assert.equal(script.split(prefix).length, 2);
    assert.equal(spawnSync("/bin/sh", ["-n", "-c", script], { encoding: "utf8" }).status, 0);
  }
});

test("input command generation rejects commands, displays, noncanonical coordinates and unsafe durations before interpolation", () => {
  const tap = ["touchscreen", "-d", "0", "tap", "1", "2"];
  const swipe = ["touchscreen", "-d", "0", "swipe", "1", "2", "3", "4", "350"];
  const sparse = [...tap]; delete sparse[4];
  const invalid: unknown[] = [null, {}, [], new Array(4), sparse, ["input", ...tap], ["-d", "0", "keyevent", "KEYCODE_HOME"],
    ["-d", "0", "keyevent", "4"], ["touchscreen", "-d", "1", "tap", "1", "2"],
    ["touchscreen", "--display", "0", "tap", "1", "2"], [...tap, "3"], [...tap.slice(0, 4), 1, "2"],
    [...swipe.slice(0, 4), "1", "2", "1", "2", "350"]];
  for (const value of ["-1", "+1", "00", "01", "1.0", "1e2", "0x10", "100001", "NaN", "Infinity", "1; id", "$(id)", "`id`", "1\nid", "x".repeat(10000)])
    invalid.push([...tap.slice(0, 4), value, "2"]);
  for (const value of ["0", "149", "1001", "0350", "350.0", "350; id", "350\n"])
    invalid.push([...swipe.slice(0, 8), value]);
  for (const suffix of ["\n", "\r", "\r\n", "\n\n", "\u2028", "\u2029", " ", "\t"]) {
    invalid.push([...tap.slice(0, 4), `1${suffix}`, "2"]);
    invalid.push([...swipe.slice(0, 8), `350${suffix}`]);
  }
  for (const value of invalid) assert.throws(() => buildInputInjectionCommand(value as string[], nonce));
});

test("both builders reject untrusted nonces, and the log builder fixes source, UID, server and epoch start", () => {
  for (const value of ["", "a".repeat(31), "a".repeat(33), "A".repeat(32), `${nonce}; id`, "$(id)",
    ...["\n", "\r", "\r\n", "\n\n", "\u2028", "\u2029", " ", "\t"].map(suffix => nonce + suffix)])
    for (const build of [() => buildInputInjectionCommand(["-d", "0", "keyevent", "KEYCODE_BACK"], value), () => buildInputInjectionLogCommand(marker, value)])
      assert.throws(build);
  const script = buildInputInjectionLogCommand(marker, nonce);
  assert.ok(script.endsWith("exec /system/bin/logcat -d -b system -v epoch -v uid --uid=1000 --pid=1582 -T 1792156358.155 -s InputManager:W '*:S'"));
  assert.ok(!script.includes(" -t ")); assert.ok(!script.includes(" -b main "));
  assert.equal(spawnSync("/bin/sh", ["-n", "-c", script], { encoding: "utf8" }).status, 0);
  assert.ok(buildInputInjectionLogCommand({ ...marker, deviceEpochMs: epoch - 155 }, nonce).includes("-T 1792156358.000 "));
  for (const field of ["remotePid", "systemServerPid", "deviceEpochMs"] as const)
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])
      assert.throws(() => buildInputInjectionLogCommand({ ...marker, [field]: value }, nonce));
  for (const value of [2147483648, "1582; id", null])
    assert.throws(() => buildInputInjectionLogCommand({ ...marker, systemServerPid: value } as typeof marker, nonce));
});

const shellLiteral = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
function simulatePrelude(date: string, pid: string, failMarker = false) {
  const script = buildInputInjectionCommand(["touchscreen", "-d", "0", "tap", "1", "2"], nonce)
    .replace("/system/bin/date", "aui_test_date").replace("/system/bin/pidof", "aui_test_pidof").replace("/system/bin/cmd", "/bin/echo");
  const functions = `aui_test_date() { /usr/bin/printf '%s' ${shellLiteral(date)}; }; aui_test_pidof() { /usr/bin/printf '%s' ${shellLiteral(pid)}; }; `;
  return spawnSync("/bin/sh", ["-c", functions + (failMarker ? "printf() { return 1; }; " : "") + script], { encoding: "utf8", timeout: 1000 });
}

test("the actual fixed prelude emits its shell PID before exec and retains the input's remaining stdout", () => {
  const result = simulatePrelude(String(epoch), "1582");
  assert.equal(result.status, 0); assert.equal(result.stderr, "");
  const parsed = parseInputInjectionMarker(result.stdout, nonce);
  assert.ok(parsed); assert.equal(parsed.remotePid, result.pid); assert.equal(parsed.systemServerPid, 1582);
  assert.equal(parsed.deviceEpochMs, epoch); assert.equal(parsed.stdout, "input touchscreen -d 0 tap 1 2\n");
});

test("bad date/server output or failed marker writing prevents any input exec", () => {
  for (const [date, pid] of [["", "1582"], ["123", "1582"], ["1792156358%3N", "1582"], ["01792156358155", "1582"],
    [String(epoch), ""], [String(epoch), "0"], [String(epoch), "01582"], [String(epoch), "1582 1583"],
    [String(epoch), "1582\n1583"], [String(epoch), "2147483648"], [String(epoch), "$(id)"], [String(epoch), "1582; id"]]) {
    const result = simulatePrelude(date, pid);
    assert.equal(result.status, 125); assert.equal(result.stdout, "");
  }
  const result = simulatePrelude(String(epoch), "1582", true);
  assert.equal(result.status, 125); assert.equal(result.stdout, "");
});

test("marker parsing accepts one initial nonce-bound marker and preserves every suffix byte for classification", () => {
  const suffix = "SecurityException: requires INJECT_EVENTS\n unexpected reply \r\n";
  for (const line of [markerLine(), markerLine().replace("\n", "\r\n")])
    assert.deepEqual(parseInputInjectionMarker(line + suffix, nonce), { ...marker, stdout: suffix });
  assert.deepEqual(parseInputInjectionMarker(markerLine(), nonce), { ...marker, stdout: "" });
});

test("missing, misplaced, duplicate, mismatched and noncanonical markers cannot become input identities", () => {
  const invalid = ["", markerLine().trimEnd(), ` ${markerLine()}`, `ordinary output\n${markerLine()}`, markerLine().replace(nonce, "f".repeat(32)),
    markerLine() + markerLine(), markerLine() + `__AUI_INPUT_${"f".repeat(32)}__:1:2:${epoch}\n`,
    markerLine("0"), markerLine("022121"), markerLine("2147483648"), markerLine("1.0"), markerLine("+1"),
    markerLine("22121", "0"), markerLine("22121", "01582"), markerLine("22121", "2147483648"),
    markerLine("22121", "1582", "179215635815"), markerLine("22121", "1582", "01792156358155"),
    markerLine("22121", "1582", "1792156358155 "), markerLine() + "\0", markerLine().replace(":1582:", ":1582 1583:"),
    markerLine().replace("\n", "\u2028\n"), markerLine().replace("\n", "\u2029\n")];
  for (const value of invalid) assert.equal(parseInputInjectionMarker(value, nonce), null);
  assert.equal(parseInputInjectionMarker(markerLine(), "bad nonce"), null);
});

test("marker output has an exact byte cap, including multibyte text", () => {
  const remaining = INPUT_INJECTION_DIAGNOSTIC_LIMITS.maxOutputBytes - Buffer.byteLength(markerLine());
  assert.equal(parseInputInjectionMarker(markerLine() + "x".repeat(remaining), nonce)!.stdout.length, remaining);
  assert.equal(parseInputInjectionMarker(markerLine() + "x".repeat(remaining + 1), nonce), null);
  assert.equal(parseInputInjectionMarker(markerLine() + "字".repeat(Math.ceil(remaining / 3) + 1), nonce), null);
});

test("only exact system-buffer UID/server/input-PID rejection events inside the device window prove rejection", () => {
  assert.equal(inspectInputInjectionLog(`--------- beginning of system\n${logLine()}\n`, context), "rejected");
  assert.equal(inspectInputInjectionLog(logLine(undefined, undefined, undefined, undefined, "timed out."), context), "rejected");
  assert.equal(inspectInputInjectionLog(logLine().replace("W InputManager:", "E InputManager     :"), context), "rejected");
  assert.equal(inspectInputInjectionLog(logLine() + "\r\n", context), "rejected");
  for (const point of [context.deviceStartedAt, context.deviceFinishedAt]) {
    const stamp = `${Math.floor(point / 1000)}.${String(point % 1000).padStart(3, "0")}`;
    assert.equal(inspectInputInjectionLog(logLine(stamp), context), "rejected");
  }
});

test("trusted headers with historical, other-input-PID or nonexact messages are distinguished from unavailable diagnostics", () => {
  const irrelevant = [logLine("1792156357.154"), logLine("1792156359.156"), logLine(undefined, undefined, undefined, "221210"),
    logLine(undefined, undefined, undefined, "022121"),
    logLine().replace("failed.", "failed. but recovered"), logLine().replace("failed.", "failed"), logLine().replace("from pid", "for pid"),
    "--------- beginning of system", "", " \t\r\n"];
  for (const value of irrelevant) assert.equal(inspectInputInjectionLog(value, context), "not_observed", value);
  assert.equal(inspectInputInjectionLog(irrelevant.join("\n"), context), "not_observed");
  const invalid = [logLine(undefined, "2000"), logLine(undefined, "system"), logLine(undefined, "01000"), logLine(undefined, undefined, "1583"),
    logLine().replace("W InputManager:", "W InputManager-JNI:"),
    logLine().replace("W InputManager:", "I InputManager:"),
    `untrusted prefix ${logLine()}`, logLine().replace("2851", "0"), logLine("1792156358.1559"), logLine("1792156358"),
    "--------- beginning of main", "Input event injection from pid 22121 failed.", `${logLine()}\u2028`, `${logLine()}\u2029`,
    "--------- beginning of system\u2028"];
  for (const value of invalid) assert.equal(inspectInputInjectionLog(value, context), "unavailable", value);
  assert.equal(inspectInputInjectionLog(`${logLine()}\n${invalid.join("\n")}`, context), "unavailable");
  assert.equal(inspectInputInjectionLog(`${invalid.join("\n")}\n${logLine()}`, context), "unavailable");
});

test("invalid identities, backwards or excessive device windows and oversized logs never prove rejection", () => {
  for (const field of ["remotePid", "systemServerPid", "deviceStartedAt", "deviceFinishedAt"] as const)
    for (const value of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER])
      assert.equal(inspectInputInjectionLog(logLine(), { ...context, [field]: value }), "unavailable");
  assert.equal(inspectInputInjectionLog(logLine(), { ...context, remotePid: 2147483648 }), "unavailable");
  assert.equal(inspectInputInjectionLog(logLine(), { ...context, deviceFinishedAt: context.deviceStartedAt - 1 }), "unavailable");
  assert.equal(inspectInputInjectionLog(logLine(), { ...context, deviceFinishedAt: context.deviceStartedAt + 10001 }), "unavailable");
  assert.equal(inspectInputInjectionLog(logLine(), { ...context, deviceStartedAt: epoch, deviceFinishedAt: epoch }), "rejected");
  assert.equal(inspectInputInjectionLog(logLine() + "\n" + "x".repeat(65536), context), "unavailable");
  assert.equal(inspectInputInjectionLog(logLine() + "\n" + "字".repeat(22000), context), "unavailable");
  assert.equal(inspectInputInjectionLog(logLine() + "\0", context), "unavailable");
});
