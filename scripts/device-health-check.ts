#!/usr/bin/env bun
// 设备健康门控：重启目标 App + 预热 + 单次整页采集计时（业务验收前先跑，避免带病硬测）。
// 每次尝试同时打印逐段用时（captureTimings）与告警、画面覆盖数；覆盖数在页面内计算，不整树回传 CDP，避免传输开销污染测量。
// 判定：采集成功、Debug 来源、往返耗时 < 阈值（默认 15s）、至少 1 张独立画面且 0 张失败 → 健康。
// 退出码：0=健康；1=不健康（仍可继续观察，但不宜跑验收探针）；2=运行失败。
// 用法：bun scripts/device-health-check.ts --serial=<serial> --require-device
//   业务 App（默认）：--app=com.smile.gifmaker --activity=com.yxcorp.gifshow.HomeActivity --warm-ms=70000
//   样例 App：--app=com.androiduiinspector.sample --activity=.MainActivity --warm-ms=8000 --mode=stress-large
//   --reuse-app：直接采集当前前台 App，避免把冷启动负载混入稳态测量。
//   --startup-probe：先启动隔离桌面，再重启 App；不点击导航、不自动掩盖首轮失败，25s 后同进程复测。
//     --warm-ms=0/40000 固定启动等待条件；每轮结果单独落盘，不将复测成功算作首轮成功。
//   --watch-ids=id1,id2：保存指定 resource-id（完整值或末段）的状态；要求每个ID至少一个屏内实例有图。
//   --refresh-node：每轮完整采集之后单独测三次可见文字叶节点刷新，不计入完整采集耗时。
//   --refresh-pixels：保存原始编码图与浏览器解码RGBA摘要；可用 --expected-refresh-sha=SHA 严格验收。
//   --single-attempt：不做额外复测或内部整页启动重试；保留首次有界窗口等待，不自动恢复。
//   --consecutive=3 --reuse-app：同会话连续三轮；不健康/内部重试/身份或覆盖数量变化立即停，不混入刷新。
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canContinueHealthSeries, canRefreshHealthCapture, shouldRetryHealthCapture, validateHealthRefresh } from "./health-refresh-validation";
import { recordStartupCommand, type StartupCommandEvidence } from "./diagnostics/startup/startup-command-evidence";
import { awaitEndpoint, connectCdp as connect, createWaits, delay, evaluateValue, pageTarget, shutdownProbeElectron, spawnProbeElectron, waitForElectronApi } from "./lib/probe-harness";

const project = fileURLToPath(new URL("../", import.meta.url));
const cliValue = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const serial = cliValue("serial") ?? execFileSync("adb", ["get-serialno"], { encoding: "utf8" }).trim();
const requireDevice = process.argv.includes("--require-device");
const appArgument = cliValue("app") ?? "com.smile.gifmaker";
const activity = cliValue("activity") ?? "com.yxcorp.gifshow.HomeActivity";
const warmMs = Number(cliValue("warm-ms") ?? (appArgument === "com.smile.gifmaker" ? 70000 : 8000));
const modeExtra = cliValue("mode") ?? (appArgument === "com.smile.gifmaker" ? null : "stress-large");
const thresholdMs = Number(cliValue("threshold-ms") ?? 15000);
const reuseApp = process.argv.includes("--reuse-app");
const startupProbe = process.argv.includes("--startup-probe");
const repeatCurrent = process.argv.includes("--repeat-current");
const singleAttempt = process.argv.includes("--single-attempt");
const consecutive = Number(cliValue("consecutive") ?? 1);
if (!Number.isSafeInteger(consecutive) || consecutive < 1 || consecutive > 3) throw new Error("--consecutive 必须为 1–3");
if (consecutive > 1 && (!reuseApp || startupProbe || repeatCurrent || process.argv.includes("--refresh-node")))
  throw new Error("连续门控只支持 --reuse-app，不混入重启、恢复或文字刷新");
if (singleAttempt && repeatCurrent) throw new Error("--single-attempt 不允许 --repeat-current 复测模式");
const refreshNode = process.argv.includes("--refresh-node");
const refreshPixels = process.argv.includes("--refresh-pixels");
const refreshText = cliValue("refresh-text");
if (refreshText && (!refreshNode || refreshText.length > 256)) throw new Error("--refresh-text 需要刷新模式及不超过256字符的文字");
const expectedRefreshSha = cliValue("expected-refresh-sha") ?? undefined;
if (expectedRefreshSha && (!refreshNode || !refreshPixels || !/^[a-f0-9]{64}$/.test(expectedRefreshSha)))
  throw new Error("--expected-refresh-sha 需要 --refresh-node --refresh-pixels 和64位像素摘要");
if (repeatCurrent && !reuseApp) throw new Error("--repeat-current 需要 --reuse-app，不重启手机 App");
if (startupProbe && reuseApp) throw new Error("--startup-probe 与 --reuse-app 不能同时使用");
if (!Number.isSafeInteger(warmMs) || warmMs < 0 || warmMs > 120000) throw new Error("--warm-ms 必须为 0–120000 的整数");
const watchIds = (cliValue("watch-ids") ?? "").split(",").filter(Boolean);
if (watchIds.length > 16 || watchIds.some(id => id.length > 256 || !/^[\w.:/-]+$/.test(id))) throw new Error("--watch-ids 最多16个合法资源ID");

const devices = execFileSync("adb", ["devices"], { encoding: "utf8" })
  .split(/\r?\n/).slice(1).map((line) => line.split("\t")).filter((cells) => cells.length === 2);
if (!devices.find((cells) => cells[0] === serial && cells[1] === "device")) {
  if (requireDevice) throw new Error(`--require-device 需要 ${serial} 在线`);
  console.log(`[skip] 未找到 ${serial}，跳过健康检查。`);
  process.exit(0);
}

const output = join(project, ".benchmarks", "device-health-check", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
console.log(`Device health check output: ${output}`);
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { timeout: 15000 });
const startupCommands: StartupCommandEvidence[] = [];
const startupAdb = (...args: string[]) => recordStartupCommand(["adb", "-s", serial, ...args], () => {
  const result = spawnSync("adb", ["-s", serial, ...args], { timeout: 15000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw Object.assign(result.error ?? new Error(`启动命令失败：${result.status}`),
    { stdout: result.stdout, stderr: result.stderr, status: result.status, signal: result.signal });
  return { stdout: result.stdout, stderr: result.stderr };
}, record => {
  startupCommands.push(record);
  // Private ignored output only; persist before propagating an exec failure.
  writeFileSync(join(output, "startup-commands.json"), JSON.stringify({ records: startupCommands,
    scope: "host launch responses only; not window readiness, PID ownership or successful capture" }, null, 2));
});
let startupCondition: { app: string; activity: string; warmMs: number; startCommandAndWaitMs: number;
  navigation: boolean; captureRequestedAt?: string } | null = null;

if (reuseApp) {
  const foreground = adb("shell", "dumpsys", "activity", "activities").toString()
    .match(/(?:mResumedActivity|topResumedActivity)[:=].*?\bu\d+\s+([^/\s]+)\//)?.[1];
  if (foreground !== appArgument) throw new Error(`当前前台是 ${foreground ?? "未知"}，需要 ${appArgument}`);
  console.log(`using current foreground ${appArgument} ...`);
} else if (!startupProbe) {
  console.log(`restarting ${appArgument} ...`);
  adb("shell", "svc", "power", "stayon", "usb");
  adb("shell", "am", "force-stop", appArgument);
  const startArgs = ["shell", "am", "start", "-n", `${appArgument}/${activity}`];
  if (modeExtra) startArgs.push("--es", "mode", modeExtra);
  adb(...startArgs);
  console.log(`warming ${warmMs}ms ...`);
  await delay(warmMs);
  if (appArgument === "com.smile.gifmaker") {
    adb("shell", "input", "tap", "324", "2312"); // 精选 feed
    await delay(4000);
  }
}

const { child, endpoint } = spawnProbeElectron({ project, userDataDir: join(output, "profile"), logDir: output,
  env: { INSPECTOR_SHORT_PARENT_DIAGNOSTICS: process.argv.includes("--short-parent-diagnostics") ? "1" : "0" } });
let exitCode = 2;
let refreshHealthy = true;
try {
  const endpointUrl = await awaitEndpoint(endpoint, "debugger startup", 20000);
  const address = new URL(endpointUrl);
  const debuggerPort = Number(address.port);
  const { waitForValue } = createWaits(child);
  const connection = await connect(await waitForValue("application window", 30000, () => pageTarget(debuggerPort).catch(() => null)));
  await waitForElectronApi(connection, 30000);

  if (startupProbe) {
    // Keep desktop startup out of the App waiting window. No hidden warm-up or feed navigation.
    startupAdb("shell", "am", "force-stop", appArgument);
    const launch = ["shell", "am", "start", "-n", `${appArgument}/${activity}`];
    if (modeExtra) launch.push("--es", "mode", modeExtra);
    const started = Date.now();
    startupAdb(...launch);
    await delay(warmMs);
    startupCondition = { app: appArgument, activity, warmMs, startCommandAndWaitMs: Date.now() - started, navigation: false };
    writeFileSync(join(output, "startup-condition.json"), JSON.stringify(startupCondition, null, 2));
    console.log(`[startup] App 启动命令结束后等待 ${warmMs}ms，桌面已就绪，无导航/预热抓图。`);
  }

  const captureOnce = async (requestId: string) => {
    const outcome = await evaluateValue<{ inspectionMode?: { mode?: string; revision?: number; busy?: boolean; error?: string }; error: string | null; nodeCount: number; inspectionSource?: string; warning?: string | null; captureTimings?: Record<string, number>; captureDurationMs?: number; debugProcessId?: string | null; diagnostics?: Record<string, string>; failedLayers?: { id: string; className: string; reason: string }[]; watchedLayers?: { resourceId: string; status: string; hasImage: boolean; inViewport: boolean }[]; coverage?: { captured: number; visible: number; failed: number }; geometryCoverage?: { verifiedRectangle: number; unsupportedContext: number; withoutEvidence: number }; previewTiming?: { treeReceivedMs: number | null; firstScreenReceivedMs: number | null; firstImageReceivedMs: number | null; imageBatches: number }; refreshTarget?: { id: string; ref: string; className: string; bounds: { left: number; top: number; right: number; bottom: number } } | null }>(connection,
      `(async () => {
        const progress = [];
        let inspectionMode = { mode: "unknown", error: "Desktop mode API unavailable" };
        try {
          if (typeof window.electronApi.getInspectionMode === 'function') inspectionMode = await window.electronApi.getInspectionMode();
        } catch (error) { inspectionMode = { mode: "unknown", error: String(error) }; }
        const started = performance.now();
        const previewTiming = { treeReceivedMs: null, firstScreenReceivedMs: null, firstImageReceivedMs: null, imageBatches: 0 };
        const unsubscribe = window.electronApi.onInspectionProgress((p) => {
          if (p.requestId === ${JSON.stringify(requestId)}) progress.push({ stage: p.stage, elapsedMs: p.elapsedMs, receivedMs: Math.round(performance.now() - started) });
        });
        const unsubscribePreview = window.electronApi.onInspectionPreview((p) => {
          if (p.requestId !== ${JSON.stringify(requestId)}) return;
          const elapsed = Math.round(performance.now() - started);
          if (previewTiming.firstScreenReceivedMs === null
              && (p.phase === 'screen' && p.screen?.screenshotDataUrl || p.phase === 'tree' && p.snapshot?.screenshotDataUrl))
            previewTiming.firstScreenReceivedMs = elapsed;
          if (p.phase === 'tree' && previewTiming.treeReceivedMs === null) previewTiming.treeReceivedMs = elapsed;
          else if (p.phase === 'layers' && p.updates.some(u => Boolean(u.layerImageDataUrl))) {
            previewTiming.imageBatches++;
            if (previewTiming.firstImageReceivedMs === null) previewTiming.firstImageReceivedMs = elapsed;
          }
        });
        try {
          const r = await window.electronApi.inspectDevice(${JSON.stringify(serial)}, ${JSON.stringify(requestId)}, undefined, ${singleAttempt}, ${reuseApp && singleAttempt ? JSON.stringify({ expectedPackage: appArgument }) : "undefined"});
          const counts = { captured: 0, visible: 0, failed: 0 };
          const geometryCoverage = { verifiedRectangle: 0, unsupportedContext: 0, withoutEvidence: 0 };
          const failedLayers = [];
          const watchedLayers = [];
          let refreshTarget = null;
          const watchIds = ${JSON.stringify(watchIds)};
          if (r.root) {
            const pending = [r.root];
            while (pending.length) {
              const node = pending.pop();
              const b = node.bounds, viewport = r.root.bounds;
              if (${refreshNode} && (${JSON.stringify(refreshText)} === null || node.text === ${JSON.stringify(refreshText)})
                && (!refreshTarget || b?.top < refreshTarget.bounds.top) && node.attributes?.['view-ref'] && node.children?.length === 0
                  && node.className?.endsWith('TextView') && !node.className.endsWith('CheckedTextView')
                  && node.text && node.visibleToUser && node.layerImageStatus === 'captured'
                  && node.layerImageDataUrl && b && viewport && b.right > b.left && b.bottom > b.top
                  && b.left >= viewport.left && b.top >= viewport.top && b.right <= viewport.right && b.bottom <= viewport.bottom) {
                refreshTarget = { id: node.id, ref: node.attributes['view-ref'], className: node.className, bounds: node.bounds };
              }
              if (watchedLayers.length < 64 && watchIds.some(id => node.resourceId === id || node.resourceId?.endsWith('/' + id))) {
                const b = node.bounds, viewport = r.root.bounds;
                watchedLayers.push({ id: node.id, resourceId: node.resourceId, className: node.className,
                  ref: node.attributes?.['view-ref'], bounds: node.bounds, visible: node.visibleToUser,
                  inViewport: Boolean(node.visibleToUser && b && viewport && b.right > b.left && b.bottom > b.top
                    && b.right > viewport.left && b.bottom > viewport.top && b.left < viewport.right && b.top < viewport.bottom),
                  status: node.layerImageStatus, hasImage: Boolean(node.layerImageDataUrl), empty: node.layerImageEmpty,
                  reason: node.attributes?.['image-capture-error'], source: node.attributes?.['image-source'] });
              }
              if (node.visibleToUser) counts.visible += 1;
              if (node.layerImageStatus === "captured") {
                counts.captured += 1;
                const placement = node.attributes?.['image-capture-placement'];
                if (placement === 'verified-rectangle') geometryCoverage.verifiedRectangle++;
                else if (placement === 'unsupported-context-legacy-fallback') geometryCoverage.unsupportedContext++;
                else geometryCoverage.withoutEvidence++;
              }
              else if (node.layerImageStatus === "failed") {
                counts.failed += 1;
                if (failedLayers.length < 32) failedLayers.push({ id: node.id, className: node.className,
                  ref: node.attributes?.["view-ref"], resourceId: node.resourceId, bounds: node.bounds,
                  source: node.attributes?.["image-source"], reason: node.attributes?.["image-capture-error"] ?? "未记录原因",
                  expectedSize: node.attributes?.["image-capture-expected-size"], actualSize: node.attributes?.["image-capture-actual-size"],
                  expectedPosition: node.attributes?.["image-capture-expected-position"], actualPosition: node.attributes?.["image-capture-actual-position"],
                  geometryKind: node.attributes?.["image-capture-geometry-kind"], positionDelta: node.attributes?.["image-capture-position-delta"],
                  ancestorEvidence: node.attributes?.["image-capture-ancestor-evidence"], evidencePhase: node.attributes?.["image-capture-evidence-phase"],
                  initialGeometry: node.attributes?.["image-capture-initial-geometry"],
                  parentContext: node.attributes?.["image-capture-parent-context"] });
              }
              if (node.children) pending.push(...node.children);
            }
          }
          const diagnostics = Object.fromEntries(Object.entries(r.root?.attributes ?? {}).filter(([key]) => /^(?:fallback-source|ddms-batch-(?:bytes|layers|images)|jdwp-(?:setup-requests|bitmap-setup-requests|thread-name-requests)|jdwp-fallback-(?:candidates|requested|skipped|field-requests|field-batches|sdk-type-avoided)|sdk-(?:first|visible|ref)-fallback|sdk-(?:tree-source|branch-geometry-version)|sdk-visible-interrupted|sdk-task-(?:queue-buckets|queue-max-ms|slow)|sdk-visible-failure-(?:phase|target|wait-ms|completed|phase-started-ms|phase-wait-ms|timing)|geometry-retry-(?:requested|recovered|error|mode|candidates|selected|selection|phase|recovery-phase|elapsed-ms|first-read-ms|capture-ms|verify-read-ms|total-ms|selection-ms|window-before-ms|geometry-ms|window-after-ms|stage-ms|commit-ms|publish-ms))$/.test(key)));
          return { inspectionMode, error: r.error, nodeCount: r.nodeCount, inspectionSource: r.inspectionSource, warning: r.warning, captureTimings: r.captureTimings, captureDurationMs: r.captureDurationMs, captureRequestDiagnostics: r.captureRequestDiagnostics, debugProcessId: (r.root?.attributes ?? {})["debug-process-id"] ?? null,
            processInstance: r.root?.attributes?.['sdk-process-instance'] ?? null, rootRef: r.root?.children?.[0]?.attributes?.['view-ref'] ?? null,
            diagnostics, coverage: counts, geometryCoverage, previewTiming, failedLayers, watchedLayers, progress, refreshTarget };
        } finally { unsubscribePreview(); unsubscribe(); }
      })()`);
    writeFileSync(join(output, `${requestId}.json`), JSON.stringify(outcome, null, 2));
    console.log(`[capture-attempts] ${JSON.stringify((outcome.value as { captureRequestDiagnostics?: unknown })?.captureRequestDiagnostics ?? null)}`);
    if (outcome.exceptionText) throw new Error(`采集 evaluate 异常：${outcome.exceptionText}`);
    if (outcome.value?.warning) console.log(`[warning] ${outcome.value.warning}`);
    if (outcome.value?.failedLayers?.length) console.log(`[failed-layers] ${JSON.stringify(outcome.value.failedLayers)}`);
    if (watchIds.length) console.log(`[watch-layers] ${JSON.stringify(outcome.value?.watchedLayers ?? [])}`);
    if (Object.keys(outcome.value?.diagnostics ?? {}).length) console.log(`[fallback] ${JSON.stringify(outcome.value?.diagnostics)}`);
    console.log(`[inspection-mode] ${JSON.stringify(outcome.value?.inspectionMode ?? null)}`);
    // API delivery only: this probe does not mount the snapshot or measure GPU/screen presentation.
    console.log(`[preview-received] ${JSON.stringify(outcome.value?.previewTiming ?? null)}`);
    console.log(`[geometry-coverage] ${JSON.stringify(outcome.value?.geometryCoverage ?? null)}`);
    const timings = outcome.value?.captureTimings;
    if (timings && Object.keys(timings).length) {
      const sorted = Object.fromEntries(Object.entries(timings).sort((left, right) => right[1] - left[1]));
      console.log(`[timings] ${Math.round(outcome.durationMs / 1000)}s ${JSON.stringify(sorted)}`);
    }
    if (refreshNode) {
      const target = outcome.value?.refreshTarget;
      const samples = [];
      if (!target || outcome.value?.error || !canRefreshHealthCapture(outcome.value, outcome.durationMs, thresholdMs, singleAttempt)) refreshHealthy = false;
      else for (let index = 0; index < 3; index++) {
        const refreshed = await evaluateValue(connection, `(async () => {
          const r = await window.electronApi.refreshViewNode(${JSON.stringify(requestId)}, ${JSON.stringify(target.id)}, 'node');
          const node = r.nodes?.find(n => n.id === ${JSON.stringify(target.id)});
          let pixels = null;
          if (${refreshPixels} && node?.layerImageDataUrl) {
            const image = new Image(); image.src = node.layerImageDataUrl; await image.decode();
            const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
            const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0);
            const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            const digest = await crypto.subtle.digest('SHA-256', rgba);
            pixels = { width: canvas.width, height: canvas.height, sha256: Array.from(new Uint8Array(digest)).map(v => v.toString(16).padStart(2, '0')).join('') };
          }
          return { failures: r.failures, id: node?.id, ref: node?.attributes?.['view-ref'], className: node?.className, bounds: node?.bounds,
            status: node?.layerImageStatus, hasImage: Boolean(node?.layerImageDataUrl), source: node?.attributes?.['image-source'],
            route: node?.attributes?.['image-refresh-route'], hardwareAccelerated: node?.attributes?.['sdk-hardwareAccelerated'], timings: r.timings, pixels,
            pixelImage: ${refreshPixels} ? node?.layerImageDataUrl : undefined };
        })()`);
        const value = refreshed.value;
        if (refreshPixels && typeof (value as any)?.pixelImage === "string") {
          writeFileSync(join(output, `${requestId}-refresh-${index}.png`), Buffer.from((value as any).pixelImage.split(',')[1], 'base64'));
          delete (value as any).pixelImage;
        }
        const { accepted, boundsMatchBaseline } = validateHealthRefresh(target, value, refreshed.exceptionText ?? undefined, expectedRefreshSha);
        samples.push({ durationMs: refreshed.durationMs, accepted, boundsMatchBaseline, value, error: refreshed.exceptionText ?? null });
        if (!accepted) { refreshHealthy = false; break; } // Do not hide failures through retries.
      }
      writeFileSync(join(output, `${requestId}-refresh.json`), JSON.stringify({ target, expectedPixelSha: expectedRefreshSha ?? null, samples }, null, 2));
      console.log(`[refresh-node] ${JSON.stringify({ target: target?.className ?? null, samples, passed: samples.length === 3 && samples.every(s => s.accepted) })}`);
    }
    return { value: outcome.value!, duration: outcome.durationMs };
  };
  if (startupCondition) {
    startupCondition.captureRequestedAt = new Date().toISOString();
    writeFileSync(join(output, "startup-condition.json"), JSON.stringify(startupCondition, null, 2));
  }
  let attempt = await captureOnce(`health-${Date.now()}`);
  const firstAttempt = attempt;
  if (consecutive > 1) {
    const attempts = [firstAttempt];
    const accepted = () => canContinueHealthSeries(attempt, firstAttempt, thresholdMs)
      && watchIds.every(id => (attempt.value.watchedLayers ?? []).some(layer =>
        (layer.resourceId === id || layer.resourceId.endsWith('/' + id)) && layer.inViewport && layer.status === 'captured' && layer.hasImage));
    while (attempts.length < consecutive && accepted()) {
      attempt = await captureOnce(`health-${Date.now()}-series-${attempts.length + 1}`);
      attempts.push(attempt);
    }
    refreshHealthy = attempts.length === consecutive && accepted();
    writeFileSync(join(output, "consecutive-summary.json"), JSON.stringify({ passed: refreshHealthy,
      requested: consecutive, attempts, scope: "same-session stable coverage counts; not cold-start or pixel correctness acceptance" }, null, 2));
    console.log(`[consecutive] ${JSON.stringify({passed: refreshHealthy, completed: attempts.length, requested: consecutive, durationsMs: attempts.map(a => a.duration)})}`);
  } else if ((startupProbe || repeatCurrent) && !singleAttempt) {
    console.log(`[startup-first] ${JSON.stringify({durationMs:attempt.duration,error:attempt.value.error,warning:attempt.value.warning,coverage:attempt.value.coverage,pid:attempt.value.debugProcessId})}`);
    await delay(25000);
    attempt = await captureOnce(`health-${Date.now()}-followup`);
    writeFileSync(join(output, repeatCurrent ? "repeat-comparison.json" : "startup-comparison.json"), JSON.stringify({ warmMs: repeatCurrent ? null : warmMs, first: firstAttempt, followup: attempt,
      sameProcess: Boolean(firstAttempt.value.debugProcessId) && firstAttempt.value.debugProcessId === attempt.value.debugProcessId }, null, 2));
  } else if (shouldRetryHealthCapture(attempt.value.error, singleAttempt)) {
    console.log(`[retry] 采集被护栏拒绝（${attempt.value.error?.slice(0, 40) ?? "未知"}），等 25s 重试。`);
    await delay(25000);
    attempt = await captureOnce(`health-${Date.now()}-retry`);
  }
  if (startupProbe && singleAttempt) writeFileSync(join(output, "startup-comparison.json"), JSON.stringify({warmMs,
    first: firstAttempt, followup: null, scope: "cold-start first request only; no automatic recovery"}, null, 2));
  const { value, duration } = attempt;
  const source = value.inspectionSource ?? "unknown";
  const coverage = value.coverage ?? { captured: 0, visible: 0, failed: 0 };
  const missingWatchedImages = watchIds.filter(id => !(value.watchedLayers ?? []).some(layer =>
    (layer.resourceId === id || layer.resourceId.endsWith("/" + id)) && layer.inViewport && layer.status === "captured" && layer.hasImage));
  const firstHealthy = canRefreshHealthCapture(firstAttempt.value, firstAttempt.duration, thresholdMs, singleAttempt)
    && !firstAttempt.value.error && !firstAttempt.value.diagnostics?.["sdk-visible-interrupted"] && firstAttempt.duration < thresholdMs
    && ["debug-view", "debug-hybrid"].includes(firstAttempt.value.inspectionSource ?? "") && (firstAttempt.value.coverage?.captured ?? 0) > 0 && firstAttempt.value.coverage?.failed === 0
    && watchIds.every(id => (firstAttempt.value.watchedLayers ?? []).some(layer =>
      (layer.resourceId === id || layer.resourceId.endsWith("/" + id)) && layer.inViewport && layer.status === "captured" && layer.hasImage));
  const healthy = canRefreshHealthCapture(value, duration, thresholdMs, singleAttempt)
    && refreshHealthy && (!(startupProbe || repeatCurrent) || firstHealthy) && (!repeatCurrent || firstAttempt.value.debugProcessId === value.debugProcessId) && !value.error && !value.diagnostics?.["sdk-visible-interrupted"] && duration < thresholdMs && (source === "debug-view" || source === "debug-hybrid") && coverage.captured > 0 && coverage.failed === 0 && missingWatchedImages.length === 0;
  if (watchIds.length) console.log(`[watch-check] ${JSON.stringify({ passed: missingWatchedImages.length === 0, missing: missingWatchedImages })}`);
  console.log(`[health] ${JSON.stringify({ error: value.error, nodeCount: value.nodeCount, inspectionSource: source, durationMs: duration, thresholdMs, captureDurationMs: value.captureDurationMs ?? null, debugProcessId: value.debugProcessId ?? null, capturedImages: coverage.captured, visibleNodes: coverage.visible, failedImages: coverage.failed })}`);
  if (coverage.captured === 0) console.log("[health] 注意：本次 0 张独立画面（补图阶段未执行或全部失败），不能代表整页采集。");
  console.log(healthy ? `[health] 结论：健康（${Math.round(duration / 1000)}s，${value.nodeCount} 节点，${source}，独立画面 ${coverage.captured} 张）` : "[health] 结论：不健康（见上；可沉降后再测，不宜跑验收探针）。");
  exitCode = healthy ? 0 : 1;

  const version = await (await fetch(`http://127.0.0.1:${debuggerPort}/json/version`)).json() as any;
  const browser = await connect(version.webSocketDebuggerUrl);
  await shutdownProbeElectron(child, browser);
} catch (error) {
  console.error(`[health] 运行失败：${(error as Error).message}`);
} finally {
  if (child.exitCode === null) child.kill();
}
process.exit(exitCode);
