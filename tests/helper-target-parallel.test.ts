import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { test } from "node:test";
import { checkedDebugTarget } from "../electron/device/target";
import { withCommandSignal } from "../electron/device/command-context";
import { createDebugTiming, runWithDebugTiming } from "../electron/device/debug-timing";

const packageName = "com.example.boundary", serial = "offline-target-parallel";
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "helper-target-parallel-"));
  const adb = join(directory, "adb"), configPath = join(directory, "config.json"), logPath = join(directory, "events.jsonl");
  writeFileSync(adb, `#!${process.execPath}\n` + `import {existsSync,readFileSync,writeFileSync,appendFileSync} from 'node:fs';\n`
    + `import {setTimeout as wait} from 'node:timers/promises';\n`
    + `const directory=${JSON.stringify(directory)},args=process.argv.slice(2),parts=args.slice(2),key=parts.join(' ');\n`
    + `const type=key==='shell dumpsys activity activities'?'activity':key===${JSON.stringify(`shell run-as ${packageName} id`)}?'debug':key==='shell dumpsys window windows'?'focus':null;\n`
    + `if(!type)process.exit(99);const config=JSON.parse(readFileSync(${JSON.stringify(configPath)},'utf8'));\n`
    + `const log=event=>appendFileSync(${JSON.stringify(logPath)},JSON.stringify({type,event,args})+'\\n');log('start');\n`
    + `writeFileSync(directory+'/'+type+'.entered','');\n`
    + `if(config.barrier&&type!=='focus')while(!existsSync(directory+'/'+type+'.release'))await wait(2);\n`
    + `if(type==='focus'&&config.barrier&&(!existsSync(directory+'/activity.done')||!existsSync(directory+'/debug.done')))process.exit(98);\n`
    + `writeFileSync(directory+'/'+type+'.done','');log('end');\n`
    + `if(type==='activity'){process.stdout.write('mResumedActivity: ActivityRecord{abc123 u0 '+(config.activityPackage??${JSON.stringify(packageName)})+'/.Main t12}\\n');process.exit(config.activityCode??0);}\n`
    + `if(type==='debug'){process.stdout.write('uid=10001(example) gid=10001(example)\\n');process.exit(config.debugCode??0);}\n`
    + `process.stdout.write('mTopFocusedDisplayId=0\\nmCurrentFocus='+ (config.nullFocus?'null':'Window{de45 u0 '+(config.focusPackage??${JSON.stringify(packageName)})+'/.Main}')+'\\n');\n`);
  chmodSync(adb, 0o700);
  const configure = (config: Record<string, unknown> = {}) => writeFileSync(configPath, JSON.stringify(config));
  configure();
  const events = () => existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const release = (type: string) => writeFileSync(join(directory, type + ".release"), "");
  const until = async (predicate: () => boolean) => {
    const deadline = performance.now() + 4000;
    while (!predicate()) { assert(performance.now() < deadline, "fixture barrier not reached"); await wait(2); }
  };
  return { adb, directory, configure, events, release, until, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

test("authorized Helper target reads activity and Debug eligibility concurrently, joins both, then checks live focus", async () => {
  const f = fixture(), controller = new AbortController(), timing = createDebugTiming(); f.configure({ barrier: true });
  const pending = withCommandSignal(controller.signal, () => runWithDebugTiming(timing,
    () => checkedDebugTarget(f.adb, serial, packageName, { parallelBoundary: true })));
  try {
    await f.until(() => f.events().filter(event => event.event === "start").length === 2);
    assert.deepEqual(f.events().filter(event => event.event === "start").map(event => event.type).sort(), ["activity", "debug"]);
    f.release("activity");
    await f.until(() => existsSync(join(f.directory, "activity.done")));
    assert(!f.events().some(event => event.type === "focus"), "focus cannot race an unfinished eligibility read");
    f.release("debug");
    const target = await pending;
    assert.equal(target.packageName, packageName); assert.equal(target.activityRecordId, "abc123"); assert.equal(target.windowId, "de45");
    const measured = timing.finish("success"); assert.equal(measured.commandCount, 3); assert.deepEqual(measured.commandCounts, { target: 3 });
    const commands = measured.spans.filter(span => span.phase === "device_command");
    assert(commands[1].startOffsetMs < commands[0].startOffsetMs + commands[0].durationMs, "actual command intervals overlap");
    assert.doesNotMatch(JSON.stringify(measured), /offline-target|example\.boundary/);
  } finally { controller.abort(); await pending.catch(() => {}); f.dispose(); }
});

test("target failure keeps priority and waits for the other read before returning without a focus query", async () => {
  const f = fixture(), controller = new AbortController(); f.configure({ barrier: true, activityCode: 5, debugCode: 7 });
  let finished = false;
  const pending = withCommandSignal(controller.signal, () => checkedDebugTarget(f.adb, serial, packageName, { parallelBoundary: true }))
    .then(value => ({ value, error: undefined }), error => ({ value: undefined, error })).finally(() => { finished = true; });
  try {
    await f.until(() => f.events().filter(event => event.event === "start").length === 2);
    f.release("activity"); await f.until(() => existsSync(join(f.directory, "activity.done"))); await wait(0);
    assert.equal(finished, false, "failed first query must join the still-running second query");
    f.release("debug"); const result = await pending; assert.match(result.error.message, /前台 App/);
    assert.equal(f.events().filter(event => event.event === "start").length, 2);
  } finally { controller.abort(); await pending; f.dispose(); }
});

test("foreign targets, non-Debug apps and invalid focus remain failures with no replacement commands", async () => {
  for (const [config, error, commands] of [
    [{ activityPackage: "other.app", debugCode: 7 }, /离开授权范围/, 2],
    [{ debugCode: 7 }, /不可调试/, 2],
    [{ focusPackage: "other.app" }, /焦点窗口不属于/, 3],
    [{ nullFocus: true }, /焦点/, 3],
  ] as const) {
    const f = fixture(); f.configure(config);
    try {
      await assert.rejects(checkedDebugTarget(f.adb, serial, packageName, { parallelBoundary: true }), error);
      const starts = f.events().filter(event => event.event === "start"); assert.equal(starts.length, commands);
      assert(starts.filter(event => event.type === "debug").every(event => event.args.includes(packageName)), "only authorized package is probed early");
    } finally { f.dispose(); }
  }
});

test("ordinary and unknown-package checks keep their sequential behavior", async () => {
  for (const [expected, options] of [[packageName, undefined], [undefined, { parallelBoundary: true }]] as const) {
    const f = fixture();
    try {
      await checkedDebugTarget(f.adb, serial, expected, options);
      assert.deepEqual(f.events().map(event => event.type + ":" + event.event),
        ["activity:start", "activity:end", "debug:start", "debug:end", "focus:start", "focus:end"]);
    } finally { f.dispose(); }
  }
});

test("invalid package, cancellation and deadline stop before focus without retries", async () => {
  const invalid = fixture(), preCancelled = new AbortController(); preCancelled.abort();
  try {
    await assert.rejects(checkedDebugTarget(invalid.adb, serial, "bad;input", { parallelBoundary: true }), /包名/);
    await assert.rejects(withCommandSignal(preCancelled.signal, () => checkedDebugTarget(invalid.adb, serial, packageName, { parallelBoundary: true })));
    assert.equal(invalid.events().length, 0);
  } finally { invalid.dispose(); }
  for (const deadline of [false, true]) {
    const f = fixture(), controller = new AbortController(); f.configure({ barrier: true });
    const pending = withCommandSignal(controller.signal, () => checkedDebugTarget(f.adb, serial, packageName, { parallelBoundary: true }));
    try {
      await f.until(() => f.events().filter(event => event.event === "start").length === 2);
      let reason: unknown = new Error("fixture cancellation");
      if (deadline) {
        const timeout = AbortSignal.timeout(1);
        await new Promise<void>(resolve => timeout.addEventListener("abort", () => {
          reason = timeout.reason; controller.abort(reason); resolve();
        }, { once: true }));
      } else controller.abort(reason);
      await assert.rejects(pending, error => error === reason);
      assert.equal(f.events().filter(event => event.event === "start").length, 2);
    } finally { controller.abort(); await pending.catch(() => {}); f.dispose(); }
  }
});
