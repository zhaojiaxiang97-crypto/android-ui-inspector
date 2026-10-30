import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import type { DisplayFrame } from "../shared/types";
import { assessCaptureGeometry, validSize } from "../shared/screen-coordinates";
import { observeDebugApp } from "../electron/automation/device-actions";
import { HelperCaptureError, readHelperDump } from "../electron/capture/accessibility-helper";
export { readHelperDump } from "../electron/capture/accessibility-helper";
import { MAX_UI_HIERARCHY_DEPTH, parseUiHierarchy } from "../electron/capture/xml-tree";
import { captureScreen, readDisplayFrame } from "../electron/device/screen";
import { automationAdb, getDebugTarget, sameActivityInstance, type DebugTarget } from "../electron/device/target";
import { inspectionContext, runCommand, runDeviceAdb } from "../electron/device/runtime";
import { openOwnedDebugForward, type OwnedDebugForward } from "../electron/platform/owned-debug-forward";
import { createProviderSessionPool } from "../electron/sdk/provider-session";

const MAX_BYTES = 8 * 1024 * 1024;
type Backend = "fast" | "helper";
const semanticSchema = z.object({ hint: z.string().min(1).max(256).optional(), error: z.string().min(1).max(256).optional(),
  "state-description": z.string().min(1).max(256).optional() }).strict().refine(value => Object.values(value).some(Boolean), "语义要求不能为空");
const selectorSchema = z.object({ name: z.string().min(1).max(80), resourceId: z.string().min(1).max(256).optional(),
  text: z.string().min(1).max(256).optional(), contentDesc: z.string().min(1).max(256).optional(), helperAttributes: semanticSchema.optional() }).strict()
  .refine(value => Boolean(value.resourceId || value.text || value.contentDesc), "目标需要明确的属性");
export const recognitionConfig = z.object({ serial: z.string().regex(/^[\w.:-]{1,256}$/),
  packageName: z.string().regex(/^[\w]+(?:\.[\w]+)+$/), component: z.string().min(3).max(512),
  runs: z.number().int().min(1).max(5).default(3), targets: z.array(selectorSchema).min(1).max(20),
  helperTokenFile: z.string().refine(isAbsolute).optional(), requireLayoutParity: z.boolean().default(false) }).strict()
  .refine(value => value.component.startsWith(`${value.packageName}/`) && /^[\w.]+\/[\w.$]+$/.test(value.component), "页面必须属于目标 App")
  .refine(value => new Set(value.targets.map(target => target.name)).size === value.targets.length, "目标名称不能重复");
type Config = z.infer<typeof recognitionConfig>;

export class RecognitionError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function reject(code: string, message: string): never { throw new RecognitionError(code, message); }
const parser = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false, parseTagValue: false, trimValues: false,
  maxNestedTags: MAX_UI_HIERARCHY_DEPTH, isArray: name => name === "node" });
const builder = new XMLBuilder({ ignoreAttributes: false, suppressBooleanAttributes: false });

export function recognitionMetrics(xml: string, backend: Backend, packageName: string, frame: DisplayFrame, targets: Config["targets"]) {
  if (!xml || Buffer.byteLength(xml) > MAX_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    reject("invalid-tree", "控件树为空、超限或格式无效");
  if (!validSize(frame)) reject("geometry", "显示尺寸无效");
  const hierarchy = parser.parse(xml).hierarchy;
  if (!hierarchy || String(frame.rotation) !== hierarchy["@_rotation"]) reject("geometry", "控件树方向与主显示器不一致");
  const roots: Record<string, unknown>[] = hierarchy.node ?? [];
  if (!roots.length || roots.length > 16) reject("empty-tree", "未获得有界的窗口树");
  let root = roots[0];
  if (backend === "helper") {
    const focused = roots.filter(node => node["@_window-focused"] === "true");
    if (focused.length !== 1 || focused[0]["@_package"] !== packageName
      || focused[0]["@_window-type"] !== "application" || !/^\d+$/.test(String(focused[0]["@_window-id"])))
      reject("window-mismatch", "Helper 未返回目标 App 的唯一焦点窗口");
    root = focused[0];
  } else if (roots.length !== 1) reject("window-mismatch", "fast 返回多个窗口，不能取第一个冒充完整结果");
  if (root["@_package"] !== packageName) reject("window-mismatch", "控件树不属于目标 App");
  const selectedXml = builder.build({ hierarchy: { "@_rotation": hierarchy["@_rotation"], node: root } });
  const tree = parseUiHierarchy(selectedXml).root;
  const pending = [tree], entries: unknown[] = [], layoutEntries: unknown[] = [];
  let visibleNodes = 0, locatableNodes = 0, interactiveNodes = 0, foreignPackageNodes = 0;
  const semantics = { hint: 0, error: 0, "state-description": 0 };
  const matches = targets.map(target => ({ name: target.name, matches: 0,
    attributes: null as Record<keyof typeof semantics, string | null> | null }));
  for (let i = 0; i < pending.length; i++) {
    if (pending.length > 5000) reject("tree-limit", "控件树超过 5000 节点评估上限");
    const node = pending[i];
    pending.push(...node.children);
    if (node.package !== packageName) { foreignPackageNodes++; continue; }
    const bounds = node.bounds;
    const located = node.visibleToUser && bounds && bounds.right > bounds.left && bounds.bottom > bounds.top
      && bounds.left < frame.width && bounds.top < frame.height && bounds.right > 0 && bounds.bottom > 0;
    if (node.visibleToUser) visibleNodes++;
    if (located) {
      locatableNodes++;
      if (node.clickable || node.focusable || node.scrollable || node.attributes?.["long-clickable"] === "true"
        || node.attributes?.editable === "true") interactiveNodes++;
      for (const key of Object.keys(semantics) as Array<keyof typeof semantics>) if (node.attributes?.[key]) semantics[key]++;
      targets.forEach((target, index) => {
        if (["resourceId", "text", "contentDesc"].every(key => !target[key as keyof typeof target]
          || node[key as "resourceId" | "text" | "contentDesc"] === target[key as keyof typeof target])) {
          matches[index].matches++;
          matches[index].attributes = matches[index].matches === 1 ? { hint: node.attributes?.hint ?? null,
            error: node.attributes?.error ?? null, "state-description": node.attributes?.["state-description"] ?? null } : null;
        }
      });
    }
    entries.push([node.className, node.resourceId, node.text, node.contentDesc, bounds, node.visibleToUser,
      node.clickable, node.enabled, node.focusable, node.scrollable, node.attributes?.hint, node.attributes?.error,
      node.attributes?.["state-description"]]);
    // Parser-generated paths encode parentage; no backend node identity participates.
    layoutEntries.push([node.id, node.className, node.resourceId, node.text, node.contentDesc,
      bounds && [bounds.left, bounds.top, bounds.right, bounds.bottom], node.visibleToUser,
      node.clickable, node.enabled, node.focusable, node.focused, node.scrollable, node.selected,
      ...["long-clickable", "checkable", "checked", "password"].map(key => node.attributes?.[key] === "true")]);
  }
  return { treeNodes: pending.length, visibleNodes, locatableNodes, interactiveNodes, foreignPackageNodes, semantics, targets: matches,
    windowCount: roots.length, helperWindowId: backend === "helper" ? String(root["@_window-id"]) : null,
    layoutFingerprint: createHash("sha256").update(JSON.stringify(layoutEntries)).digest("hex"),
    fingerprint: createHash("sha256").update(JSON.stringify(entries)).digest("hex") };
}

export function assertRecognitionIdentity(expected: DebugTarget, actual: DebugTarget, frame: DisplayFrame, current: DisplayFrame) {
  if (expected.packageName !== actual.packageName || !sameActivityInstance(expected, actual) || expected.windowId !== actual.windowId)
    reject("target-changed", "App、页面实例或焦点窗口已变化");
  if (frame.rotation !== current.rotation || frame.width !== current.width || frame.height !== current.height)
    reject("geometry", "主显示器方向或尺寸已变化");
}


type Observation = { xml: string; target: DebugTarget; frame: DisplayFrame; screenshotDataUrl?: string | null };
type Attempt = { backend: Backend; run: number; durationMs: number; metrics?: ReturnType<typeof recognitionMetrics>;
  error: { code: string; message: string } | null };
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted[middle] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2 : null;
};
export async function compareRecognition(config: Config, expected: DebugTarget, frame: DisplayFrame,
  capture: Partial<Record<Backend, (signal: AbortSignal) => Promise<Observation>>>, signal?: AbortSignal,
  save?: (attempt: Attempt, observation?: Observation) => void) {
  const attempts: Attempt[] = [], fingerprints: Partial<Record<Backend, string>> = {}, helperWindows: string[] = [];
  for (let run = 1; run <= config.runs && !signal?.aborted; run++) {
    // Alternate order; retain first samples and any service suppression after a UIAutomator dump.
    for (const backend of (run % 2 ? ["helper", "fast"] : ["fast", "helper"]) as Backend[]) {
      if (!capture[backend] || signal?.aborted) continue;
      const started = performance.now(), attempt: Attempt = { backend, run, durationMs: 0, error: null };
      let observation: Observation | undefined;
      const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
      try {
        observation = await capture[backend]!(deadline);
        deadline.throwIfAborted();
        assertRecognitionIdentity(expected, observation.target, frame, observation.frame);
        attempt.metrics = recognitionMetrics(observation.xml, backend, config.packageName, frame, config.targets);
        if (attempt.metrics.targets.some(target => target.matches !== 1)) reject("target-coverage", "目标缺失或存在多个匹配");
        if (backend === "helper" && config.targets.some((target, index) => Object.entries(target.helperAttributes ?? {})
          .some(([key, value]) => attempt.metrics!.targets[index].attributes?.[key as keyof z.infer<typeof semanticSchema>] !== value)))
          reject("semantic-coverage", "Helper 目标的提示、错误或状态描述与样例预期不符");
        if (fingerprints[backend] && fingerprints[backend] !== attempt.metrics.fingerprint) reject("page-changed", "同一后端的页面内容或节点几何已变化");
        fingerprints[backend] = attempt.metrics.fingerprint;
        if (attempt.metrics.helperWindowId) {
          if (helperWindows.length && helperWindows[0] !== attempt.metrics.helperWindowId) reject("window-mismatch", "Helper 窗口身份已变化");
          helperWindows.push(attempt.metrics.helperWindowId);
        }
      } catch (error) {
        attempt.error = { code: (error instanceof RecognitionError || error instanceof HelperCaptureError) ? error.code : signal?.aborted ? "cancelled"
          : deadline.aborted || (error instanceof Error && error.name === "TimeoutError") ? "timeout" : "capture-failed",
          message: (error instanceof Error ? error.message : String(error)).slice(0, 2000) };
      }
      attempt.durationMs = Math.round(performance.now() - started);
      attempts.push(attempt);
      save?.(attempt, observation);
    }
  }
  const summary = Object.fromEntries((["fast", "helper"] as Backend[]).map(backend => {
    const samples = attempts.filter(attempt => attempt.backend === backend), successful = samples.filter(attempt => !attempt.error);
    let streak = 0, maxSuccessStreak = 0;
    for (const sample of samples) { streak = sample.error ? 0 : streak + 1; maxSuccessStreak = Math.max(streak, maxSuccessStreak); }
    return [backend, { attempts: samples.length, successful: successful.length, successRate: samples.length ? successful.length / samples.length : null,
      maxSuccessStreak, totalDurationMs: samples.reduce((sum, sample) => sum + sample.durationMs, 0),
      medianDurationMs: median(samples.map(sample => sample.durationMs)), medianSuccessDurationMs: median(successful.map(sample => sample.durationMs)) }];
  }));
  const layoutParity = Array.from({ length: config.runs }, (_, index) => {
    const fast = attempts.find(attempt => attempt.backend === "fast" && attempt.run === index + 1);
    const helper = attempts.find(attempt => attempt.backend === "helper" && attempt.run === index + 1);
    return { run: index + 1, matched: fast?.metrics && helper?.metrics && !fast.error && !helper.error
      ? fast.metrics.layoutFingerprint === helper.metrics.layoutFingerprint : null,
      fastNodes: fast?.metrics?.treeNodes ?? null, helperNodes: helper?.metrics?.treeNodes ?? null };
  });
  const validationError = config.requireLayoutParity && layoutParity.some(pair => pair.matched !== true)
    ? { code: "layout-coverage", message: "完整布局比较要求两边的节点、父子结构、核心属性与边界一致；本轮未通过" } : null;
  return { attempts, summary, layoutParity, validationError, cancelled: Boolean(signal?.aborted), comparable: !validationError
    && (["fast", "helper"] as Backend[]).every(backend => summary[backend].successful === config.runs) };
}

async function main() {
  const configFile = process.argv[2];
  if (!configFile || process.argv.length !== 3) throw new Error("用法：bun scripts/recognition-comparison.ts <配置JSON>，见 docs/LOOKIN_ALIGNMENT_PLAN.md");
  if (statSync(configFile).size > 16 * 1024) throw new Error("配置超过 16KiB");
  const config = recognitionConfig.parse(JSON.parse(readFileSync(configFile, "utf8")));
  const root = join(process.cwd(), ".benchmarks", "recognition-comparison");
  mkdirSync(root, { recursive: true });
  const output = mkdtempSync(join(root, "run-"));
  const writeJson = (name: string, value: unknown) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  const controller = new AbortController(), stop = () => controller.abort(new Error("用户停止采集"));
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  let forward: OwnedDebugForward | undefined;
  const report: Record<string, unknown> = { schemaVersion: 2, kind: "physical-device", createdAt: new Date().toISOString(), attempts: [],
    config: { ...config, helperTokenFile: undefined }, helper: { status: "not-ready", reason: "未提供已配对 Helper 的令牌文件" },
    timing: "每次调用含身份校验、树、同一路径PNG截图、几何校验和分析；不含转发建立和证据写盘。失败计入总耗时，截图与树不保证同帧。",
    limitations: ["仅主显示器 Debug App；布局一致仅对照当前fast无障碍树，不是整页真实View覆盖率", "Helper 内部读根可能重试，协议未返回次数；本工具每次仅发送一个 GET", "UIAutomator 可能暂时抑制无障碍服务，相关失败保留；不自动修复或重试", "本入口不管理安装/启用、启动或后台场景；场景实测另留证，UIAutomator2未测"] };
  const started = performance.now();
  const provider = createProviderSessionPool();
  try {
    const adbPath = automationAdb(config.serial);
    await inspectionContext.run({ signal: controller.signal }, async () => {
      const expected = await getDebugTarget(config.serial, config.packageName, controller.signal);
      if (expected.component !== config.component) reject("target-changed", "请先打开配置中的固定页面；工具不会导航或启动 App");
      const frame = await readDisplayFrame(adbPath, config.serial);
      if (!frame) reject("geometry", "无法确认主显示器");
      report.identity = { ...expected, frame };
      const version = async () => {
        const info = await runDeviceAdb(adbPath, config.serial, ["shell", "dumpsys", "package", config.packageName]);
        const text = info.stdout.toString("utf8"), versionCode = text.match(/\bversionCode=(\d+)/)?.[1];
        if (info.code !== 0 || !versionCode) reject("app-version", "无法确认 App 版本");
        return { versionCode, versionName: text.match(/\bversionName=([^\r\n]+)/)?.[1]?.trim() ?? null };
      };
      const appVersion = await version(); report.appVersion = appVersion;
      const capture: Partial<Record<Backend, (signal: AbortSignal) => Promise<Observation>>> = {
        fast: async signal => {
          const result = await observeDebugApp(provider, config.serial, config.packageName, "fast", signal);
          return { xml: result.snapshot.rawXml!, target: result.target, frame: result.snapshot.captureGeometry!.afterScreenshot!,
            screenshotDataUrl: result.snapshot.screenshotDataUrl };
        },
      };
      const helperStarted = performance.now();
      if (config.helperTokenFile) {
        try {
          const info = statSync(config.helperTokenFile);
          if (!info.isFile() || info.size > 1024 || (info.mode & 0o077)) reject("helper-config", "令牌文件须≤1KiB且仅当前用户可读写");
          const token = readFileSync(config.helperTokenFile, "utf8").trim();
          if (!/^[A-Za-z0-9_-]{16,256}$/.test(token)) reject("helper-config", "Helper 令牌格式无效");
          forward = await openOwnedDebugForward(config.serial, "tcp:18888", controller.signal, (args, timeout) => inspectionContext.exit(async () => {
            const reply = await runCommand(adbPath, args, timeout);
            if (reply.code !== 0) reject("helper-forward", "Helper 转发命令失败");
            return reply.stdout.toString("utf8");
          }));
          capture.helper = signal => inspectionContext.run({ signal }, async () => {
            const before = await getDebugTarget(config.serial, config.packageName, signal);
            assertRecognitionIdentity(expected, before, frame, frame);
            const dump = await readHelperDump(forward!.port, token, signal);
            const screen = await captureScreen(adbPath, config.serial);
            const geometry = screen.captureGeometry && { ...screen.captureGeometry, hierarchyRotation: dump.rotation };
            if (!screen.screenshotDataUrl || assessCaptureGeometry(geometry).status !== "checked"
              || dump.width !== frame.width || dump.height !== frame.height) reject("geometry", "Helper 与 PNG 截图的主显示器几何不一致");
            const after = await getDebugTarget(config.serial, config.packageName, signal);
            assertRecognitionIdentity(before, after, frame, geometry!.afterScreenshot!);
            return { xml: dump.xml, target: after, frame: geometry!.afterScreenshot!, screenshotDataUrl: screen.screenshotDataUrl };
          });
          report.helper = { status: "configured", devicePort: 18888 };
        } catch (error) { report.helper = { status: "not-ready", reason: error instanceof Error ? error.message : String(error) }; }
      }
      report.helperSetupMs = Math.round(performance.now() - helperStarted);
      const result = await compareRecognition(config, expected, frame, capture, controller.signal, (attempt, observation) => {
        (report.attempts as Attempt[]).push(attempt);
        const prefix = `${attempt.backend}-${attempt.run}`;
        if (observation) {
          writeFileSync(join(output, `${prefix}.xml`), observation.xml, { mode: 0o600 });
          if (observation.screenshotDataUrl) writeFileSync(join(output, `${prefix}.png`), Buffer.from(observation.screenshotDataUrl.split(",")[1], "base64"), { mode: 0o600 });
        }
        writeJson(`${prefix}.json`, attempt);
      });
      Object.assign(report, result);
      if (JSON.stringify(appVersion) !== JSON.stringify(await version())) reject("app-version", "采集期间 App 版本已变化");
    });
  } catch (error) {
    report.comparable = false;
    report.error = { code: (error instanceof RecognitionError || error instanceof HelperCaptureError) ? error.code : "preflight-failed", message: error instanceof Error ? error.message : String(error) };
  } finally {
    try { await provider.dispose(); } catch { report.providerCleanup = "failed"; report.comparable = false; }
    if (forward) {
      try {
        await forward.close();
        report.forwardCleanup = "removed-owned-forward";
      } catch { report.forwardCleanup = "failed"; report.comparable = false; }
    }
    report.totalDurationMs = Math.round(performance.now() - started);
    writeJson("report.json", report);
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  }
  console.log(JSON.stringify({ output, comparable: report.comparable ?? false, summary: report.summary, helper: report.helper,
    layoutParity: report.layoutParity, validationError: report.validationError }));
  if (!report.comparable) process.exitCode = 1;
}

if (import.meta.main) await main();
