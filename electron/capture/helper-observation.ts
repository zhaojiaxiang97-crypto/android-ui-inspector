import sharp from "sharp";
import { z } from "zod";
import { XMLParser } from "fast-xml-parser";
import type { DisplayFrame, UiSnapshot } from "../../shared/types";
import { assessHelperRecoveryEvidence, hasCompleteHelperTree, isHelperObservationEvidence, type HelperObservationEvidence } from "../../shared/helper-observation";
import type { HelperRecoveryDiagnostics, HelperRecoverySection } from "../../shared/helper-recovery-diagnostics";
import { parseHelperObservationDiagnostics } from "../../shared/helper-observation-diagnostics";
import { HelperCaptureError, selectHelperHierarchy } from "./accessibility-helper";
import { MAX_UI_HIERARCHY_DEPTH } from "./xml-tree";
import { measureDebugPhase, measureDebugPhaseSync } from "../device/debug-timing";

function reject(code: string, message: string): never { throw new HelperCaptureError(code, message); }
export type HelperFetch = typeof fetch;
const positive = z.number().int().positive();
const capabilitiesSchema = z.object({ success: z.literal(true), protocolVersion: z.literal(1), serviceInstanceId: z.uuid(),
  capabilities: z.object({ tree: z.literal(true), screenshot: z.literal(true), losslessScreenshot: z.literal(true), completeFields: z.literal(true),
    windowIdentity: z.literal(true), visibleBounds: z.literal(true), includeInvisible: z.literal(true), orderedObservation: z.literal(true),
    guardedInput: z.literal(true).optional() }).strict(),
  screenshotFormat: z.literal("png"), visibility: z.literal("explicit-clipped") }).strict();
const serviceError = z.string().max(1024);
// This envelope can only reject a response. Successful captures still pass the strict schema below.
const failureEnvelopeSchema = z.object({ success: z.boolean().optional(), truncated: z.boolean().optional(),
  error: serviceError.optional(), helperObservation: z.object({ complete: z.boolean().optional() }).passthrough().optional() }).passthrough();
const observationSchema = z.object({ success: z.literal(true), xml: z.string().min(1), truncated: z.literal(false),
  width: positive.max(16384), height: positive.max(16384), rotation: z.number().int().min(0).max(3),
  window_count: positive.max(16), node_count: positive.max(5000), has_screenshot: z.literal(true), screenshot_format: z.literal("png"),
  screenshot_base64: z.string().min(1).max(24 * 1024 * 1024), helperObservation: z.unknown(), error: serviceError.optional() }).strict();

async function request(port: number, token: string, path: string, maxBytes: number, signal: AbortSignal, fetcher: HelperFetch) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[A-Za-z0-9_-]{16,256}$/.test(token)) reject("helper-config", "Helper 端口或令牌格式无效。");
  signal.throwIfAborted();
  const chunks = await measureDebugPhase("helper_request", async () => {
    const response = await measureDebugPhase("helper_request_headers", () => fetcher(`http://127.0.0.1:${port}${path}`, {
      method: "GET", redirect: "error", headers: { "X-Artemis-Token": token }, signal,
    }));
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      reject("helper-http", `Helper 返回 HTTP ${response.status}；请确认已安装并启用支持观察协议的版本。`);
    }
    return measureDebugPhase("helper_response_read", async () => {
      const reader = response.body?.getReader();
      if (!reader) reject("helper-empty", "Helper 响应为空。");
      const chunks: Uint8Array[] = [];
      let size = 0;
      const aborted = () => { void reader.cancel(signal.reason).catch(() => undefined); };
      signal.addEventListener("abort", aborted, { once: true });
      try {
        while (true) {
          signal.throwIfAborted();
          const next = await reader.read();
          signal.throwIfAborted();
          if (next.done) break;
          size += next.value.length;
          if (size > maxBytes) reject("helper-size", "Helper 响应超过大小限制。");
          chunks.push(next.value);
        }
      } finally { signal.removeEventListener("abort", aborted); await reader.cancel().catch(() => undefined); }
      return chunks;
    });
  });
  return measureDebugPhaseSync("helper_json_parse", () => {
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { return reject("helper-format", "Helper 响应不是有效 JSON。"); }
  });
}

export async function readHelperCapabilities(port: number, token: string, signal: AbortSignal, fetcher: HelperFetch = fetch) {
  const result = capabilitiesSchema.safeParse(await request(port, token, "/inspector/capabilities", 16 * 1024, signal, fetcher));
  if (!result.success) reject("helper-capabilities", "Helper 不具备完整观察能力；需要 Android 11 以上及协议 v1，不能用于自动操作。");
  return result.data;
}

async function losslessPng(base64: string, frame: DisplayFrame, signal: AbortSignal) {
  const encoded = /^[A-Za-z0-9+/]*={0,2}$/.exec(base64);
  if (base64.length % 4 !== 0 || encoded?.[0].length !== base64.length) reject("helper-image", "Helper PNG 编码无效。");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > 16 * 1024 * 1024 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") reject("helper-image", "Helper 未返回有效的无损 PNG。");
  signal.throwIfAborted();
  try {
    const decoder = sharp(bytes, { failOn: "warning", limitInputPixels: 16 * 1024 * 1024 }).timeout({ seconds: 2 });
    const metadata = await decoder.metadata();
    if (metadata.format !== "png" || metadata.width !== frame.width || metadata.height !== frame.height || (metadata.pages ?? 1) !== 1)
      reject("helper-image", "Helper PNG 的尺寸或格式与显示器不一致。");
    // Header-only inspection accepts truncated files. Force decoding before publishing pixel evidence.
    await decoder.stats();
  } catch (error) {
    if (error instanceof HelperCaptureError) throw error;
    reject("helper-image", "Helper PNG 解码失败。");
  }
  signal.throwIfAborted();
  return `data:image/png;base64,${base64}`;
}

export async function readHelperObservation(port: number, token: string, packageName: string, frame: DisplayFrame,
  signal: AbortSignal, fetcher: HelperFetch = fetch) {
  const payload = await request(port, token, "/inspector/snapshot", 32 * 1024 * 1024, signal, fetcher);
  const { tree, captureGeometry, evidence, screenshot } = measureDebugPhaseSync("helper_tree", () => validateTree(payload, packageName, frame));
  const screenshotDataUrl = await measureDebugPhase("helper_png_validation", () => losslessPng(screenshot, frame, signal));
  return { ...tree, captureGeometry, helperObservation: evidence, screenshotDataUrl };
}

function validateTree(payload: unknown, packageName: string, frame: DisplayFrame) {
  const failure = failureEnvelopeSchema.safeParse(payload);
  if (failure.success) {
    const diagnostics = parseHelperObservationDiagnostics(failure.data.helperObservation?.diagnostics);
    const rejectFailure = (code: string, message: string): never => {
      // Only a complete transport envelope and strictly validated metadata can allow a read-only retry.
      const parsed = code === "helper-incomplete" ? observationSchema.safeParse(payload) : undefined;
      let recoveryDiagnostics: HelperRecoveryDiagnostics = { version: 1,
        transport: code !== "helper-incomplete" ? "failure_not_recoverable" : !parsed?.success ? "envelope_invalid"
          : parsed.data.width !== frame.width || parsed.data.height !== frame.height || parsed.data.rotation !== frame.rotation ? "display_mismatch"
            : parsed.data.window_count !== (failure.data.helperObservation?.windowsBefore as unknown[] | undefined)?.length ? "window_count_mismatch" : "accepted" };
      if (parsed && !parsed.success) {
        const raw = payload as Record<string, unknown>;
        const groups: [HelperRecoverySection, (keyof typeof observationSchema.shape)[]][] = [
          ["envelope", ["success", "truncated", "error"]], ["tree", ["xml", "node_count", "window_count"]],
          ["display", ["width", "height", "rotation"]], ["image", ["has_screenshot", "screenshot_format", "screenshot_base64"]],
        ];
        const invalidSections = groups.filter(([, keys]) => keys.some(key => !observationSchema.shape[key].safeParse(raw[key]).success)).map(([section]) => section);
        if (Object.keys(raw).some(key => !Object.prototype.hasOwnProperty.call(observationSchema.shape, key))) invalidSections.push("unknown_fields");
        if (invalidSections.length) recoveryDiagnostics.invalidSections = invalidSections;
      }
      const assessment = parsed?.success && recoveryDiagnostics.transport === "accepted"
        ? assessHelperRecoveryEvidence(parsed.data.helperObservation, packageName, frame) : undefined;
      if (assessment) recoveryDiagnostics = { ...recoveryDiagnostics, ...assessment.diagnostics };
      throw new HelperCaptureError(code, message, { diagnostics, recoveryEvidence: assessment?.evidence, recoveryDiagnostics });
    };
    // Never echo service error strings: they may contain page text or arbitrary exception details.
    if (failure.data.success === false) rejectFailure("helper-capture-failed", "Helper 采集失败，未接受本次观察；需要重新观察后才能自动操作。");
    if (failure.data.truncated === true) rejectFailure("helper-truncated", "Helper 控件树被截断，可能达到节点数或层级上限；未接受本次观察。");
    if (failure.data.helperObservation?.complete === false)
      rejectFailure("helper-incomplete", "Helper 观察完整性检查未通过（控件字段、窗口或屏幕状态），未接受本次观察。");
    if (failure.data.error !== undefined) rejectFailure("helper-service-error", "Helper 返回采集异常标记，未接受本次观察。");
  }
  const parsed = observationSchema.safeParse(payload);
  if (!parsed.success) reject("helper-invalid", "Helper 未返回完整树和 PNG，不能用于自动操作。");
  const dump = parsed.data, evidence = dump.helperObservation;
  if (!isHelperObservationEvidence(evidence) || evidence.packageName !== packageName
    || evidence.displayBefore.width !== frame.width || evidence.displayBefore.height !== frame.height || evidence.displayBefore.rotation !== frame.rotation
    || dump.window_count !== evidence.windowsBefore.length) reject("helper-evidence", "Helper 窗口、方向或观察完整性证据无效。");
  const tree = selectHelperHierarchy(dump, packageName, frame);
  const roots = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false, parseTagValue: false, trimValues: false,
    maxNestedTags: MAX_UI_HIERARCHY_DEPTH, isArray: name => name === "node" }).parse(dump.xml).hierarchy.node as Record<string, unknown>[];
  const nodes = [...roots];
  for (let i = 0; i < nodes.length; i++) {
    if (nodes.length > 5000) reject("helper-invalid", "Helper 节点超限。");
    nodes.push(...(nodes[i].node as Record<string, unknown>[] ?? []));
  }
  if (nodes.length !== dump.node_count || new Set(roots.map(root => root["@_window-id"])).size !== roots.length
    || roots.some(root => !evidence.windowsBefore.some(w => w.id === root["@_window-id"]
    && w.packageName === root["@_package"] && w.type === root["@_window-type"] && String(w.focused) === root["@_window-focused"])))
    reject("helper-evidence", "Helper 控件树与窗口清单不一致。");
  const captureGeometry = { hierarchyRotation: frame.rotation, beforeScreenshot: evidence.displayBefore, afterScreenshot: evidence.displayAfter,
    screenshotSize: { width: dump.width, height: dump.height } };
  const snapshot: UiSnapshot = { serial: "", root: tree.root, nodeCount: tree.nodeCount, xmlSize: Buffer.byteLength(tree.xml), rawXml: tree.xml,
    screenshotDataUrl: null, error: null, warning: null, inspectionSource: "accessibility-helper", captureGeometry, helperObservation: evidence };
  if (!hasCompleteHelperTree(snapshot)) reject("helper-fields", "Helper 缺少明确的可见性、可见边界或控件字段。");
  return { tree, captureGeometry, evidence: evidence as HelperObservationEvidence, screenshot: dump.screenshot_base64 };
}
