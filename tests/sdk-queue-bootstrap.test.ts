import assert from "node:assert/strict";
import { test } from "node:test";
import { createQueueIdentityBootstrap, parseDiagnosticIdentity, readDiagnosticIdentity } from "../scripts/diagnostics/sdk/sdk-queue-bootstrap";
import { verifyInstalledQueueApk, verifyQueueProcess } from "../scripts/diagnostics/sdk/sdk-queue-identity";
import { verifyLocalQueueBuild } from "../scripts/diagnostics/sdk/sdk-queue-build";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const sourceSha256 = "a".repeat(64), apkSha256 = "b".repeat(64), aarSha256 = "c".repeat(64);
const processInstance = "22222222-2222-2222-2222-222222222222", nonce = "d".repeat(64);
const target = { serial: "fixture", packageName: "example.app", pid: 42, startTicks: "100",
  apkPath: "/trusted/fixture.apk", aarPath: "/trusted/fixture.aar" };
const build = { sourceSha256, apkSha256, aarSha256, sdkVersion: `sdk-source-v1:${sourceSha256}` };
const installed = { apkSha256, installedPath: "/data/app/fixture/base.apk" };
const expected = { sourceSha256, pid: 42, nonce };
const reply = (challenge: string = nonce) => `Result: Bundle[{processInstance=${processInstance}, sourceSha256=${sourceSha256}, protocol=sdk-diagnostic-identity-v1, pid=42, nonce=${challenge}, result=ok}]`;

function fixture() {
  const calls: string[] = [], queries: Parameters<typeof readDiagnosticIdentity>[0][] = [];
  const dependencies: Required<NonNullable<Parameters<typeof createQueueIdentityBootstrap>[1]>> = {
    verifyLocal: async (apk, aar, signal) => {
      calls.push("local"); assert.equal(apk, target.apkPath); assert.equal(aar, target.aarPath);
      signal.throwIfAborted(); return { ...build };
    },
    verifyInstalled: async (actual, digest) => {
      calls.push("installed"); assert.equal(actual.packageName, target.packageName);
      assert.equal(digest, apkSha256); return { ...installed };
    },
    verifyProcess: async actual => {
      calls.push("process"); assert.equal(actual.pid, 42); assert.equal(actual.startTicks, "100");
      return { pid: 42, startTicks: "100" };
    },
    readIdentity: async (query, signal) => {
      calls.push("query"); queries.push(query); assert.equal(query.sourceSha256, sourceSha256);
      assert.ok(!("processInstance" in query));
      return readDiagnosticIdentity(query, signal, async (args, timeout, actualSignal) => {
        assert.equal(timeout, 2000); assert.equal(actualSignal, signal);
        assert.deepEqual(args, ["-s", "fixture", "shell", "content", "call", "--uri", "content://example.app.inspector",
          "--method", "read-diagnostic-identity", "--arg", query.nonce, "--extra", "pid:s:42"]);
        return reply(query.nonce);
      });
    },
  };
  return { calls, queries, dependencies };
}

test("bootstrap parser binds all six scalar fields; old SDK, replay, duplicate and malformed replies fail", () => {
  assert.equal(parseDiagnosticIdentity(reply(), expected).processInstance, processInstance);
  for (const value of [reply("e".repeat(64)), reply().replace("pid=42", "pid=43"),
    reply().replace(sourceSha256, "f".repeat(64)), reply().replace(processInstance, "unknown"),
    reply().replace("sdk-diagnostic-identity-v1", "sdk-source-v1"),
    reply().replace("nonce=" + nonce + ", ", ""), reply().replace("result=ok", "error=unsupported"),
    reply().replace("pid=42", "pid=42, pid=42"), reply().replace("pid=42", "pid=42=43"),
    reply().replace("pid=42", "extra=42"), reply() + "\n" + reply(), "x".repeat(4097)])
    assert.throws(() => parseDiagnosticIdentity(value, expected));
  for (const bad of [{ ...expected, nonce: "weak" }, { ...expected, pid: -1 }, { ...expected, sourceSha256: "unknown" }])
    assert.throws(() => parseDiagnosticIdentity(reply(), bad), /expectation/);
});

test("exit-zero content failures retain stdout/stderr without passing identity or retrying", async () => {
  for (const output of [
    { stdout: "", stderr: "Error while accessing provider:example.app.inspector\nSecurityException: denied" },
    { stdout: "Result: Bundle[{error=Unauthorized diagnostic identity query}]", stderr: "" },
    { stdout: reply(), stderr: "Error while accessing provider:example.app.inspector\nRemoteException during external reference release" },
    { stdout: reply("e".repeat(64)), stderr: "warning" },
    { stdout: "x".repeat(5000), stderr: "y".repeat(5000) },
  ]) {
    let calls = 0;
    await assert.rejects(readDiagnosticIdentity({ ...target, ...expected }, new AbortController().signal, async () => {
      calls++; return output;
    }), error => {
      const details = error as Error & { code: number; killed: boolean; signal: null; stdout: string; stderr: string; outputTruncated?: boolean };
      assert.equal(details.code, 0); assert.equal(details.killed, false); assert.equal(details.signal, null);
      assert.equal(details.stdout, output.stdout.slice(0, 4096)); assert.equal(details.stderr, output.stderr.slice(0, 4096));
      if (output.stdout.length > 4096) assert.equal(details.outputTruncated, true);
      assert.match(details.message, /unavailable|mismatch|too large/); return true;
    });
    assert.equal(calls, 1);
  }
});

test("identity accepts a valid bounded reply with harmless stderr, preserves legacy strings, and rejects malformed or cancelled output", async () => {
  const query = { ...target, ...expected }, signal = new AbortController().signal;
  for (const output of [reply(), { stdout: reply(), stderr: "* daemon started successfully *\n" }])
    assert.equal((await readDiagnosticIdentity(query, signal, async () => output)).processInstance, processInstance);
  for (const output of [null, 1, { stdout: reply(), stderr: 42 }, { stdout: reply() }, { stderr: "bad" }])
    await assert.rejects(readDiagnosticIdentity(query, signal, async () => output as any), /command reply/);
  await assert.rejects(readDiagnosticIdentity(query, signal, async () => ({ stdout: reply(), stderr: "字".repeat(1400) })), /too large/);
  await assert.rejects(readDiagnosticIdentity(query, signal, async () => "bad reply"), error => {
    const details = error as Error & { code: number; stderr?: string };
    assert.equal(details.code, 0); assert.equal(details.stderr, undefined); return true;
  });
  const controller = new AbortController(), reason = Error("cancel identity output");
  await assert.rejects(readDiagnosticIdentity(query, controller.signal, async () => {
    controller.abort(reason); return { stdout: reply(), stderr: "late output" };
  }), error => error === reason);
});

test("a real local content-like child can exit zero with stderr; the identity parser keeps its error evidence, no adb", async () => {
  let completed = false;
  await assert.rejects(readDiagnosticIdentity({ ...target, ...expected }, new AbortController().signal, async () => {
    const result = await promisify(execFile)(process.execPath, ["-e", "process.stderr.write('provider not published'); process.exit(0)"], {
      timeout: 2000, encoding: "utf8", maxBuffer: 4096,
    });
    completed = true; return result;
  }), error => {
    assert.equal(completed, true);
    const details = error as Error & { code: number; stdout: string; stderr: string };
    assert.equal(details.code, 0); assert.equal(details.stdout, ""); assert.equal(details.stderr, "provider not published");
    assert.match(details.message, /unavailable/); return true;
  });
});

test("bootstrap has no construction effects; one fresh query is bracketed by actual identity adapters", async () => {
  const f = fixture(), mutable = { ...target };
  const entry = createQueueIdentityBootstrap(mutable, f.dependencies);
  assert.deepEqual(f.calls, []); mutable.pid = 99;
  const identity = await entry.run(new AbortController().signal);
  assert.deepEqual(f.calls, ["local", "installed", "process", "query", "installed", "process"]);
  assert.deepEqual(identity, { ...target, processInstance, pid: 42, sourceSha256, sdkVersion: build.sdkVersion,
    apkSha256, aarSha256, installedPath: installed.installedPath });
  assert.ok(Object.isFrozen(identity)); assert.ok(Object.isFrozen(f.queries[0]));
  assert.match(f.queries[0].nonce, /^[a-f0-9]{64}$/);
  await assert.rejects(entry.run(new AbortController().signal), /already consumed/);
  assert.equal(f.queries.length, 1);
});

test("bootstrap composes real local hashing, installed APK and /proc parsers with the production scalar request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "queue-bootstrap-"));
  try {
    const apkPath = join(directory, "fixture.apk"), aarPath = join(directory, "fixture.aar");
    writeFileSync(apkPath, "bootstrap-apk"); writeFileSync(aarPath, "bootstrap-aar");
    const commands: string[][] = [];
    const fields = Array(25).fill("0"); fields[0] = "S"; fields[19] = target.startTicks;
    const stat = `42 (example.app) ${fields.join(" ")}`;
    let verifiedSha = "";
    const result = await createQueueIdentityBootstrap({ ...target, apkPath, aarPath }, {
      verifyLocal: (apk, aar, signal) => verifyLocalQueueBuild(apk, aar, signal,
        async () => JSON.stringify({ protocol: "sdk-source-v1", sourceSha256 })),
      verifyInstalled: (actual, sha, signal) => {
        verifiedSha = sha;
        return verifyInstalledQueueApk(actual, sha, signal, async args => {
          commands.push(args);
          return Buffer.from(args.includes("sha256sum") ? `${sha}  ${installed.installedPath}\n`
            : `package:${installed.installedPath}\n`);
        });
      },
      verifyProcess: (actual, signal) => verifyQueueProcess(actual, signal, async args => {
        commands.push(args); return Buffer.from(`${stat}\nexample.app\0\0${stat}\n`);
      }),
      readIdentity: (query, signal) => readDiagnosticIdentity(query, signal, async args => {
        commands.push(args); return reply(query.nonce);
      }),
    }).run(new AbortController().signal);
    assert.equal(result.apkSha256, verifiedSha);
    assert.equal(result.processInstance, processInstance); assert.equal(result.startTicks, "100");
    assert.equal(commands.length, 9); // 2 APK brackets (3 each), 2 system reads, 1 scalar query.
    assert.equal(commands.filter(args => args.includes("read-diagnostic-identity")).length, 1);
    assert.ok(commands.every(args => args.includes("pm") || args.includes("sha256sum")
      || args.includes("cat") || args.includes("read-diagnostic-identity")));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("each explicit entry has a new random challenge; a previously accepted reply cannot bootstrap the next", async () => {
  const f = fixture(), g = fixture();
  await createQueueIdentityBootstrap(target, f.dependencies).run(new AbortController().signal);
  g.dependencies.readIdentity = async query => {
    g.queries.push(query); return parseDiagnosticIdentity(reply(f.queries[0].nonce), query);
  };
  await assert.rejects(createQueueIdentityBootstrap(target, g.dependencies).run(new AbortController().signal), /mismatch/);
  assert.notEqual(f.queries[0].nonce, g.queries[0].nonce);
  assert.deepEqual(g.calls, ["local", "installed", "process"]);
});

test("invalid target and pre-cancellation never contact the device, and a cancelled entry is consumed", async () => {
  const f = fixture();
  for (const invalid of [{ ...target, pid: 0 }, { ...target, serial: "bad device" },
    { ...target, packageName: "bad" }, { ...target, startTicks: "unknown" }, { ...target, apkPath: "relative.apk" }])
    assert.throws(() => createQueueIdentityBootstrap(invalid, f.dependencies));
  const controller = new AbortController(); controller.abort(Error("cancelled"));
  const entry = createQueueIdentityBootstrap(target, f.dependencies);
  await assert.rejects(entry.run(controller.signal), /cancelled/);
  await assert.rejects(entry.run(new AbortController().signal), /consumed/);
  assert.deepEqual(f.calls, []);
});

test("parallel run cannot issue a second query or reset a pending entry", async () => {
  const f = fixture(); let release!: () => void;
  f.dependencies.verifyLocal = async () => { await new Promise<void>(resolve => { release = resolve; }); return build; };
  const entry = createQueueIdentityBootstrap(target, f.dependencies), signal = new AbortController().signal;
  const pending = entry.run(signal);
  await assert.rejects(entry.run(signal), /consumed/); release();
  assert.equal((await pending).processInstance, processInstance); assert.equal(f.queries.length, 1);
});

test("query validates before command, uses one bounded call, and refuses timeout or late cancellation without retry", async () => {
  let calls = 0;
  const query = { ...target, sourceSha256, nonce }, controller = new AbortController();
  await assert.rejects(readDiagnosticIdentity({ ...query, nonce: "bad" }, controller.signal,
    async () => { calls++; return reply(); }), /expectation/);
  assert.equal(calls, 0);
  await assert.rejects(readDiagnosticIdentity(query, controller.signal, async () => {
    calls++; throw Error("timeout");
  }), /timeout/);
  await assert.rejects(readDiagnosticIdentity(query, controller.signal, async () => {
    calls++; controller.abort(Error("late cancel")); return reply();
  }), /late cancel/);
  assert.equal(calls, 2);
});

test("local/installed/runtime identity errors stop once, never capture or retry, and consume the entry", async () => {
  for (const phase of ["local", "installed-before", "process-before", "query", "installed-after", "process-after"]) {
    const f = fixture(); let installedReads = 0, processReads = 0;
    const local = f.dependencies.verifyLocal, install = f.dependencies.verifyInstalled;
    const process = f.dependencies.verifyProcess, query = f.dependencies.readIdentity;
    f.dependencies.verifyLocal = async (...args) => {
      if (phase === "local") throw Error("fixture fault"); return local(...args);
    };
    f.dependencies.verifyInstalled = async (...args) => {
      const at = ++installedReads === 1 ? "installed-before" : "installed-after";
      if (phase === at) throw Error("fixture fault"); return install(...args);
    };
    f.dependencies.verifyProcess = async (...args) => {
      const at = ++processReads === 1 ? "process-before" : "process-after";
      if (phase === at) throw Error("fixture fault"); return process(...args);
    };
    f.dependencies.readIdentity = async (...args) => {
      if (phase === "query") throw Error("fixture fault"); return query(...args);
    };
    const entry = createQueueIdentityBootstrap(target, f.dependencies);
    await assert.rejects(entry.run(new AbortController().signal), /fixture fault/, phase);
    await assert.rejects(entry.run(new AbortController().signal), /consumed/, phase);
    assert.ok(installedReads <= 2 && processReads <= 2 && f.queries.length <= 1, phase);
  }
});

test("all stages refuse late cancellation even if the adapter ignores abort", async () => {
  for (let cancelledAt = 1; cancelledAt <= 6; cancelledAt++) {
    const f = fixture(), controller = new AbortController(); let stage = 0;
    const mark = () => { if (++stage === cancelledAt) controller.abort(Error("stage cancelled")); };
    const local = f.dependencies.verifyLocal, installedRead = f.dependencies.verifyInstalled;
    const processRead = f.dependencies.verifyProcess, query = f.dependencies.readIdentity;
    f.dependencies.verifyLocal = async (...args) => { const value = await local(...args); mark(); return value; };
    f.dependencies.verifyInstalled = async (...args) => { const value = await installedRead(...args); mark(); return value; };
    f.dependencies.verifyProcess = async (...args) => { const value = await processRead(...args); mark(); return value; };
    f.dependencies.readIdentity = async (...args) => { const value = await query(...args); mark(); return value; };
    await assert.rejects(createQueueIdentityBootstrap(target, f.dependencies).run(controller.signal), /stage cancelled/);
    assert.equal(stage, cancelledAt);
  }
});

test("PID reuse and installed replacement after the scalar read never publish a verified identity", async () => {
  for (const change of ["pid-before", "start-before", "pid-after", "start-after", "apk-before", "apk-after", "path-after", "sdk-source", "instance"]) {
    const f = fixture(); let processes = 0, installs = 0;
    f.dependencies.verifyProcess = async () => {
      const suffix = ++processes === 1 ? "before" : "after";
      return { pid: change === `pid-${suffix}` ? 43 : 42, startTicks: change === `start-${suffix}` ? "101" : "100" };
    };
    f.dependencies.verifyInstalled = async () => {
      const suffix = ++installs === 1 ? "before" : "after";
      return { apkSha256: change === `apk-${suffix}` ? "f".repeat(64) : apkSha256,
        installedPath: change === "path-after" && suffix === "after" ? "/data/app/replaced/base.apk" : installed.installedPath };
    };
    const query = f.dependencies.readIdentity;
    f.dependencies.readIdentity = async (...args) => {
      const value = await query(...args);
      if (change === "sdk-source") value.sourceSha256 = "f".repeat(64);
      if (change === "instance") value.processInstance = "unknown";
      return value;
    };
    await assert.rejects(createQueueIdentityBootstrap(target, f.dependencies).run(new AbortController().signal), /changed|mismatch/, change);
    assert.ok(f.queries.length <= 1);
  }
});
