// Sample-only true hardware/software windows, strict desktop route + pixel gate.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureSdkRefLayers } from "../../../electron/capture/sdk-images";
import { createProviderSessionPool } from "../../../electron/sdk/provider-session";
import type { UiNode } from "../../../shared/types";
const serial = process.argv[2];
assert.ok(serial && /^[\w.-]+$/.test(serial));
const sample = "com.androiduiinspector.sample";
const output = join(import.meta.dirname, "../../../.benchmarks/text-admission", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8", timeout: 30000 });
const originalWindow = adb("shell", "dumpsys", "window");
const previous = /mCurrentFocus=.*?\bu\d+\s+([\w.]+\/[\w.$]+)/.exec(originalWindow)?.[1];
const initialForwards = new Set(adb("forward", "--list").trim().split("\n"));
const records: unknown[] = [];
console.log(`Admission output: ${output}`);
const cleanup = () => {
  for (const file of ["no_backup/inspector-ref-layers.bin", "no_backup/inspector-ref-layers.bin.tmp"]) {
    assert.equal(spawnSync("adb", ["-s", serial, "shell", "run-as", sample, "test", "-e", file], { timeout: 10000 }).status, 1);
  }
};
const provider = createProviderSessionPool();
try {
  assert.ok(!(process.argv.includes("--software-only") && process.argv.includes("--hardware-only")), "choose one window mode");
  for (const hardware of process.argv.includes("--software-only") ? [false] : process.argv.includes("--hardware-only") ? [true] : [true, false]) {
    const activity = hardware ? "HardwareTextActivity" : "SoftwareTextActivity";
    adb("shell", "am", "start", "-S", "-W", "-n", `${sample}/.${activity}`);
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.match(adb("shell", "content", "call", "--uri", `content://${sample}.inspector`, "--method", "capture"), /result=ok/);
    const tree = JSON.parse(adb("exec-out", "run-as", sample, "cat", "no_backup/inspector-hierarchy.json"));
    if (tree.uiWakeVersion === 1) {
      const wake = (nonce: string, instance: string) => adb("shell", "content", "call", "--uri", `content://${sample}.inspector`, "--method", "wake-ui", "--arg", nonce, "--extra", `processInstance:s:${instance}`);
      assert.match(wake("invalid", tree.processInstance), /Invalid wake identity/);
      assert.match(wake("0123456789abcdef", "00000000-0000-0000-0000-000000000000"), /Invalid wake identity/);
      const accepted = wake("0123456789abcdef", tree.processInstance);
      assert.match(accepted, /result=ok/); assert.ok(accepted.includes(`pid=${tree.pid}`));
      assert.ok(accepted.includes(`processInstance=${tree.processInstance}`));
    }
    const pending = [tree.root]; const texts: any[] = [];
    while (pending.length) { const n = pending.pop(); if (["Admission Text", "Software layer"].includes(n.text)) texts.push(n); pending.push(...n.children); }
    assert.equal(texts.length, 2);
    for (const node of texts) assert.equal(node.hardwareAccelerated, hardware, "software layer must retain its real window acceleration flag");
    const root = { attributes: { "sdk-process-instance": tree.processInstance, "sdk-ref-debug-canvas-version": "1" }, children: [{ attributes: { "view-ref": tree.root.ref } }] } as unknown as UiNode;
    const target = texts.find(n => n.text === "Admission Text");
    if (!hardware) {
      await assert.rejects(() => captureSdkRefLayers(provider, "adb", serial, sample, root, [target.ref], true, "sdk-enhanced"), /hardware acceleration/);
      cleanup();
      const recovery = await captureSdkRefLayers(provider, "adb", serial, sample, root, [target.ref], false, "sdk-enhanced");
      assert.equal(recovery.failures.size, 0); assert.equal(recovery.images.size, 1); cleanup();
      writeFileSync(join(output, "software-recovery.json"), JSON.stringify({ hardwareAccelerated: false, forcedHardwareRejected: true, normalCaptureRecovered: true, filesCleaned: true }));
      assert.equal(tree.uiWakeVersion, 1, "do not start desktop software capture without the new safe wake capability");
      // The SDK serves one persistent client at a time. Release this probe's
      // direct connection before an isolated desktop process opens its own.
      await provider.releaseAll();
    }
    let baseline: string | undefined, signature: string | undefined;
    for (const enabled of hardware ? [false, true, true, false] : [false, true]) {
      const args = [join(import.meta.dirname, "../../device-health-check.ts"), `--serial=${serial}`, "--require-device", `--app=${sample}`, "--reuse-app", "--refresh-node", "--refresh-pixels", "--refresh-text=Admission Text"];
      if (baseline) args.push(`--expected-refresh-sha=${baseline}`);
      const child = spawn(process.execPath, args, { env: { ...process.env, INSPECTOR_ENABLE_SDK_TEXT_REFRESH: enabled ? "1" : "0" } });
      let log = "";
      child.stdout.on("data", chunk => { log += chunk.toString(); }); child.stderr.on("data", chunk => { log += chunk.toString(); });
      const code = await new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
      writeFileSync(join(output, `${hardware ? "hardware" : "software"}-${records.length}.log`), log);
      assert.equal(code, 0, log.slice(-1400));
      const directory = /Device health check output: (.+)/.exec(log)?.[1]; assert.ok(directory);
      const refreshFile = readdirSync(directory!).filter(name => name.endsWith("-refresh.json")); assert.equal(refreshFile.length, 1);
      const result = JSON.parse(readFileSync(join(directory!, refreshFile[0]), "utf8"));
      assert.equal(result.samples.length, 3);
      for (const entry of result.samples) {
        const value = entry.value;
        assert.equal(entry.accepted, true); assert.equal(entry.boundsMatchBaseline, true);
        assert.equal(value.hardwareAccelerated, String(hardware));
        assert.equal(value.route === "sdk-text-hardware", hardware && enabled);
        baseline ??= value.pixels.sha256;
        assert.equal(value.pixels.sha256, baseline);
        const next = JSON.stringify({ pixels: value.pixels, bounds: value.bounds, ref: value.ref });
        signature ??= next; assert.equal(next, signature);
      }
      records.push({ hardware, enabled, samples: 3, route: result.samples[0].value.route, pixelsMatch: true });
      console.log(JSON.stringify(records.at(-1)));
    }
  }
  const result = { passed: true, scope: process.argv.includes("--hardware-only") ? "hardware-only" : process.argv.includes("--software-only") ? "software-only" : "hardware-and-software", records,
    softwareDesktopPassed: records.some((record: any) => record.hardware === false) };
  writeFileSync(join(output, "summary.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await provider.dispose();
  // Isolated Electron exits may leave their ADB forwards registered. Remove
  // only this run's new sample-session forwards, never pre-existing clients.
  for (const line of adb("forward", "--list").trim().split("\n")) {
    const [device, local, remote] = line.trim().split(/\s+/);
    if (!initialForwards.has(line) && device === serial && /^tcp:\d+$/.test(local ?? "")
        && remote === `localabstract:${sample}.inspector.session`) adb("forward", "--remove", local);
  }
  adb("shell", "am", "force-stop", sample);
  if (previous && !previous.startsWith(sample + "/")) adb("shell", "am", "start", "-W", "-n", previous);
}
