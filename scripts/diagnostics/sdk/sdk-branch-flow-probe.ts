// Real full-capture IPC flow. Faults live only in the Debug sample's View, not the SDK or desktop.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { awaitEndpoint, connectCdp, createWaits, delay, evaluateValue, pageTarget, shutdownProbeElectron, spawnProbeElectron, waitForElectronApi } from "../../lib/probe-harness";

const serial = process.argv[2]; assert.ok(serial && /^[\w.:-]+$/.test(serial), "Usage: bun scripts/diagnostics/sdk/sdk-branch-flow-probe.ts SERIAL");
const restartSession = process.argv.includes("--same-session-restart");
const alphaVisibility = process.argv.includes("--alpha-visibility");
const expectAlphaRejection = process.argv.includes("--expect-alpha-rejection");
const dynamicRejection = process.argv.includes("--dynamic-rejection");
assert.ok(!expectAlphaRejection || alphaVisibility, "--expect-alpha-rejection requires --alpha-visibility");
assert.ok(!alphaVisibility || !restartSession, "alpha test cannot combine with restart test");
assert.ok(!dynamicRejection || !alphaVisibility && !restartSession, "dynamic rejection test requires its own session");
const project = join(import.meta.dirname, "../../.."), app = "com.androiduiinspector.sample";
const output = join(project, ".benchmarks/branch-flow", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { timeout: 15000 }).toString();
const previous = /(?:mResumedActivity:|topResumedActivity=).*?\s([\w.]+\/[\w.$]+)\s/.exec(adb("shell", "dumpsys", "activity", "activities"))?.[1];
const originalForwards = new Set(adb("forward", "--list").trim().split(/\r?\n/));
let child: ReturnType<typeof spawnProbeElectron>["child"] | undefined;
let cdp: Awaited<ReturnType<typeof connectCdp>> | undefined;
const results: any[] = [];
try {
  const modes = dynamicRejection ? ["branch-recovery-root-change", "branch-recovery-moving-again"] : alphaVisibility ? ["branch-recovery-alpha"] : restartSession ? ["branch-recovery", "branch-recovery"] : ["branch-recovery", "branch-recovery-timeout"];
  for (const [modeIndex, mode] of modes.entries()) {
    adb("shell", "am", "force-stop", app);
    adb("shell", "am", "start", "-n", `${app}/.MainActivity`, "--es", "mode", mode);
    await delay(1500);
    // Fault scenarios are isolated; --same-session-restart deliberately retains
    // the desktop/cache across two App processes. Timeout follow-up stays in one process.
    if (!child) {
      const launched = spawnProbeElectron({ project, userDataDir: join(output, mode), logDir: output });
      child = launched.child;
      const port = Number(new URL(await awaitEndpoint(launched.endpoint, "desktop", 20000)).port);
      cdp = await connectCdp(await createWaits(child).waitForValue("page", 30000, () => pageTarget(port)));
      await waitForElectronApi(cdp, 30000);
    }
    for (const followup of mode.endsWith("timeout") || dynamicRejection ? [false, true] : [false]) {
      if (followup) await delay(1500);
      const request = `branch-flow-${Date.now()}`;
      const outcome: { value: any; exceptionText: string | null; durationMs: number } = await evaluateValue<any>(cdp!, `(async () => {
        const events = [], stages = [], seen = new Map();
        const all = root => { const nodes = [root]; for(let i=0;i<nodes.length;i++) nodes.push(...nodes[i].children); return nodes; };
        const parent = root => all(root).find(n => n.className?.endsWith('$DecoratedParent'));
        const off = window.electronApi.onInspectionPreview(e => {
          if(e.requestId !== ${JSON.stringify(request)}) return;
          if(e.phase === 'tree') {
            seen.clear(); all(e.snapshot.root).forEach(n => seen.set(n.id, n));
            events.push({ phase: 'tree', bounds: parent(e.snapshot.root)?.bounds });
          } else {
            const ids = []; for(const u of e.updates) {
              const n = seen.get(u.id); if(!n) continue;
              seen.set(u.id, {...n, ...u});
              if(n.className?.endsWith('$DecoratedParent')) ids.push({ id: u.id, bounds: n.bounds, status: u.layerImageStatus });
            } events.push({ phase: 'layers', count: e.updates.length, parent: ids });
          }
        });
        const offProgress = window.electronApi.onInspectionProgress(e => { if(e.requestId === ${JSON.stringify(request)}) stages.push(e.stage); });
        try {
          const s = await window.electronApi.inspectDevice(${JSON.stringify(serial)}, ${JSON.stringify(request)});
          const nodes = s.root ? all(s.root) : [], p = s.root && parent(s.root);
          return { error: s.error, source: s.inspectionSource, nodes: nodes.length, events, stages, pid: s.root?.attributes?.['debug-process-id'],
            hiddenAlpha: nodes.filter(n => n.attributes?.['sdk-alpha'] === '0').map(n => ({visible:n.visibleToUser,status:n.layerImageStatus,hasImage:!!n.layerImageDataUrl})),
            diagnostics: Object.fromEntries(Object.entries(s.root?.attributes ?? {}).filter(([k]) => /^(geometry-retry|sdk-tree-source|sdk-branch-geometry-version|sdk-first-fallback|sdk-ref-fallback)/.test(k))),
            failed: nodes.filter(n => n.layerImageStatus === 'failed').map(n => ({ id:n.id, reason:n.attributes?.['image-capture-error'] })),
            parent: p && { bounds:p.bounds, status:p.layerImageStatus, hasImage:!!p.layerImageDataUrl }, timings: s.captureTimings };
        } finally { off(); offProgress(); }
      })()`);
      assert.equal(outcome.exceptionText, null);
      const r = { mode, modeIndex, followup, ...outcome.value, durationMs: outcome.durationMs }; results.push(r);
      writeFileSync(join(output, "result.json"), JSON.stringify({ passed: false, results }, null, 2));
      assert.equal(r.error, null); assert.equal(r.diagnostics["sdk-tree-source"], "merged");
      assert.equal(r.diagnostics["sdk-branch-geometry-version"], "1");
      const initial = r.events.find((e: any) => e.phase === "tree" && e.bounds)?.bounds;
      assert.ok(initial && r.parent);
      if (!followup) {
        assert.ok(Number(r.diagnostics["geometry-retry-window-before-ms"]) >= 0);
        assert.ok(Number(r.diagnostics["geometry-retry-total-ms"]) >= Number(r.diagnostics["geometry-retry-geometry-ms"]));
        if (r.diagnostics["geometry-retry-mode"] === "atomic-sdk-branch") {
          assert.equal(r.diagnostics["geometry-retry-recovery-phase"], "committed");
          for (const key of ["window-after", "stage", "commit", "publish"]) assert.ok(Number(r.diagnostics[`geometry-retry-${key}-ms`]) >= 0);
        } else assert.notEqual(r.diagnostics["geometry-retry-recovery-phase"], "committed");
      }
      if (alphaVisibility) {
        assert.ok(r.hiddenAlpha.length > 0);
        assert.ok(r.hiddenAlpha.every((n: any) => !n.visible && n.status === "hidden" && !n.hasImage));
      }
      if (dynamicRejection && !followup) {
        const rootChange = mode.endsWith("root-change");
        assert.match(r.diagnostics["geometry-retry-error"], rootChange ? /首次复读.*祖先 #0 的子项数量/ : /补图后复读.*分支节点 #1 的位置/);
        assert.equal(r.diagnostics["geometry-retry-phase"], rootChange ? "first-check" : "final-check");
        assert.ok(Number(r.diagnostics["geometry-retry-first-read-ms"]) >= 0);
        assert.equal(r.diagnostics["geometry-retry-capture-ms"] === undefined, rootChange);
        assert.equal(r.diagnostics["geometry-retry-verify-read-ms"] === undefined, rootChange);
        assert.equal(r.diagnostics["geometry-retry-mode"], undefined);
        assert.deepEqual(r.parent.bounds, initial); assert.equal(r.parent.hasImage, false);
        assert.equal(r.failed.length, 3);
        assert.ok(r.events.filter((e: any) => e.phase === "tree").every((e: any) => e.bounds?.left === initial.left));
      } else if (expectAlphaRejection) {
        assert.match(r.diagnostics["geometry-retry-error"], /首次复读.*分支节点 #1 的可见状态/);
        assert.equal(r.diagnostics["geometry-retry-mode"], undefined);
        assert.deepEqual(r.parent.bounds, initial); assert.equal(r.parent.hasImage, false);
        assert.equal(r.failed.length, 3);
      } else if (!followup && !mode.endsWith("timeout")) {
        assert.equal(r.diagnostics["geometry-retry-mode"], "atomic-sdk-branch");
        assert.equal(r.diagnostics["geometry-retry-recovered"], "3");
        assert.equal(r.parent.bounds.left, initial.left + 12); assert.equal(r.parent.bounds.top, initial.top + 12);
        assert.ok(r.events.some((e: any) => e.phase === "tree" && e.bounds?.left === r.parent.bounds.left));
        assert.ok(r.parent.hasImage); assert.equal(r.failed.length, 0);
      } else if (!followup) {
        assert.ok(r.diagnostics["geometry-retry-error"]);
        assert.equal(r.diagnostics["geometry-retry-mode"], undefined);
        assert.deepEqual(r.parent.bounds, initial); assert.equal(r.parent.hasImage, false);
        assert.equal(r.failed.length, 3);
        assert.ok(r.events.filter((e: any) => e.phase === "tree").every((e: any) => e.bounds?.left === initial.left));
        assert.ok(r.timings["几何失配局部重试"] < 5500);
      } else { assert.equal(r.failed.length, 0); assert.ok(r.parent.hasImage); }
      assert.ok(!r.stages.some((s: string) => /JDWP/.test(s)), "unexpected debugger fallback");
      console.log(JSON.stringify({ mode, followup, durationMs:r.durationMs, failed:r.failed.length, diagnostics:r.diagnostics }));
    }
    if (!restartSession || modeIndex === modes.length - 1) {
      await shutdownProbeElectron(child, cdp!); cdp!.close(); cdp = undefined; child = undefined;
    }
  }
  if (restartSession) assert.notEqual(results[0].pid, results[1].pid, "the App must actually restart while the desktop session stays alive");
  writeFileSync(join(output, "result.json"), JSON.stringify({ passed: true, results }, null, 2));
  console.log(JSON.stringify({ passed: true, output }));
} catch (error) { writeFileSync(join(output, "failure.txt"), String(error)); throw error; }
finally {
  if(cdp && child) { await shutdownProbeElectron(child, cdp); cdp.close(); } else child?.kill();
  for (const line of adb("forward", "--list").trim().split(/\r?\n/)) {
    const [device, port, target] = line.trim().split(/\s+/);
    if (!originalForwards.has(line) && device === serial && /^tcp:\d+$/.test(port)
      && target === `localabstract:${app}.inspector.session`) adb("forward", "--remove", port);
  }
  if(previous && !previous.startsWith(`${app}/`)) adb("shell", "am", "start", "-n", previous);
}
