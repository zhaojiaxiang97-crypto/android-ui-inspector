import { XMLParser } from "fast-xml-parser";
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import net from "node:net";
import { setTimeout as wait } from "node:timers/promises";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { AdbProbeResult, CaptureGeometry, DeviceInfo, DisplayFrame, QmlGroupImage, UiBounds, UiNode, UiSnapshot, ViewRefreshResult, ViewStyleResult } from "../shared/types";
import { assessCaptureGeometry, isRotation } from "../shared/screen-coordinates";
import { parseInputDisplay, pngSize } from "./capture-display";
import { inspectQmlHierarchy, type QmlDebugNode, type QmlGrab } from "./qml-debug";
import { captureViewLayers, captureViewBitmaps, matchesViewRoot, parseCapturedViewLayers, parseCapturedViewLayerPrefix, probeWindowName, type CapturedViewLayer } from "./view-debug";
import { qmlColorCss, qmlStyleSvg } from "../shared/qml-style";
import { textureDimensions } from "../shared/layer-textures";
import { adoptSdkTree, joinSdkTreeAndDebugImages, MAX_POSITION_DRIFT_PX, sdkGroupBranchMatches, verifySdkTreeBeforeImages } from "./sdk-hybrid";

const COMMAND_TIMEOUT_MS = 30_000;
const APP_READY_TIMEOUT_MS = 18_000;
const APP_READY_MIN_READ_MS = 1_500;
const PREVIEW_SCREEN_TIMEOUT_MS = 8_000;
const FINAL_SCREEN_TIMEOUT_MS = 15_000;
const STARTUP_IMAGE_TIMEOUT_MS = 55_000;
const IMAGE_TIMEOUT_MS = 90_000;
const STARTUP_RETRY_TIMEOUT_MS = 45_000;
const MAX_UI_HIERARCHY_DEPTH = 200;
const QML_DEBUG_PORT = 3768;
type InspectionOptions = { signal?: AbortSignal; onProgress?: (stage: string, elapsedMs: number) => void; onPreview?: (phase: "tree" | "layers", snapshot: UiSnapshot) => void; onViewTreeReady?: (packageName: string, root: UiNode, mode?: "adopt", prefetched?: unknown) => Promise<void>; expectedPackage?: string; pinFirstComponent?: string | null; startupRetry?: boolean; allowAppRestart?: boolean; preferVisibleSdk?: boolean; priorityViewRef?: string };
// Task-local cancellation also covers nested ADB commands, without affecting probes.
const inspectionContext = new AsyncLocalStorage<InspectionOptions>();
/** Merged `capture-visible` support per device+package; older SDKs ignore the extra and use the classic fetch. */
const mergedTreeSupport = new Map<string, boolean>();

/** Experimental persistent session per device+package: one adb forward and one socket replace a `content` CLI process per call. */
type ProviderSession = {
  adbPath: string;
  serial: string;
  packageName: string;
  socket: net.Socket;
  port: number;
  buffer: string;
  lastUsedAt: number;
  pending: Array<{ resolve: (line: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>;
};
const providerSessions = new Map<string, Promise<ProviderSession | null>>();
const sessionSupport = new Map<string, boolean>();

/** 会话通道空闲回收：超过该毫秒数没有任何请求的会话自动关闭；≤0 禁用（INSPECTOR_SESSION_IDLE_MS 覆盖，便于用短阈值验证）。 */
const sessionIdleMs = (() => {
  const raw = process.env.INSPECTOR_SESSION_IDLE_MS;
  if (raw === undefined || raw.trim() === "") return 300_000;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 300_000;
})();
/** 空闲回收判定（纯函数便于单测）：有在飞请求、未到阈值或禁用时不回收。 */
export function shouldReclaimSession(args: { idleMs: number; now: number; lastUsedAt: number; pendingCount: number }): boolean {
  return args.idleMs > 0 && args.pendingCount === 0 && args.now - args.lastUsedAt >= args.idleMs;
}
if (sessionIdleMs > 0) {
  const sweep = setInterval(() => {
    for (const pending of [...providerSessions.values()]) {
      void pending.then((session) => {
        if (!session) return;
        if (shouldReclaimSession({ idleMs: sessionIdleMs, now: Date.now(), lastUsedAt: session.lastUsedAt, pendingCount: session.pending.length })) void closeProviderSession(session);
      }).catch(() => undefined);
    }
  }, Math.max(1_000, Math.min(30_000, Math.floor(sessionIdleMs / 3))));
  sweep.unref();
}

const sessionKey = (serial: string, packageName: string) => `${serial}|${packageName}`;

function openProviderSession(adbPath: string, serial: string, packageName: string): Promise<ProviderSession | null> {
  const key = sessionKey(serial, packageName);
  const existing = providerSessions.get(key);
  if (existing) return existing;
  // The open is session infrastructure: keep it outside the capture signal so a cancelled
  // capture still leaves the session usable for the next one.
  const opening = (async () => {
    const reply = await inspectionContext.exit(() => runDeviceAdb(adbPath, serial, ["shell", "content", "call", "--uri", `content://${packageName}.inspector`, "--method", "open-session"], 15_000));
    const output = reply.stdout.toString("utf8");
    if (reply.code !== 0 || !/\bresult=ok\b/.test(output)) throw new Error("open-session rejected");
    const forward = await inspectionContext.exit(() => runDeviceAdb(adbPath, serial, ["forward", "tcp:0", `localabstract:${packageName}.inspector.session`], 15_000));
    const portText = forward.stdout.toString("utf8").trim();
    if (forward.code !== 0 || !/^\d+$/.test(portText)) throw new Error("无法转发会话端口");
    const port = Number(portText);
    return await new Promise<ProviderSession>((resolve, fail) => {
      const socket = net.connect({ port, host: "127.0.0.1" });
      socket.setNoDelay(true);
      const session: ProviderSession = { adbPath, serial, packageName, socket, port, buffer: "", lastUsedAt: Date.now(), pending: [] };
      let connected = false;
      socket.on("connect", () => { connected = true; resolve(session); });
      const drop = () => {
        if (providerSessions.get(key) === opening) providerSessions.delete(key);
        for (const waiter of session.pending.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error("会话通道已断开"));
        }
      };
      socket.on("data", (chunk: Buffer) => {
        session.buffer += chunk.toString("utf8");
        let index: number;
        while ((index = session.buffer.indexOf("\n")) >= 0) {
          const line = session.buffer.slice(0, index);
          session.buffer = session.buffer.slice(index + 1);
          const waiter = session.pending.shift();
          if (waiter) { clearTimeout(waiter.timer); waiter.resolve(line); session.lastUsedAt = Date.now(); }
        }
      });
      socket.on("error", drop);
      socket.on("close", drop);
      socket.on("error", () => { if (!connected) { connected = true; fail(new Error("无法连接会话通道")); } });
    });
  })().catch(() => {
    sessionSupport.set(key, false);
    return null;
  });
  providerSessions.set(key, opening);
  return opening;
}

function sessionRequest(session: ProviderSession, payload: { method: string; arg: string | null; extras: Record<string, string | boolean> }, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: undefined as unknown as ReturnType<typeof setTimeout> };
    waiter.timer = setTimeout(() => {
      const at = session.pending.indexOf(waiter);
      if (at >= 0) session.pending.splice(at, 1);
      reject(new Error(`会话调用超时：${payload.method}`));
    }, timeoutMs);
    session.pending.push(waiter);
    session.lastUsedAt = Date.now();
    session.socket.write(`${JSON.stringify(payload)}\n`);
  });
}

async function closeProviderSession(session: ProviderSession) {
  const key = sessionKey(session.serial, session.packageName);
  providerSessions.delete(key);
  for (const waiter of session.pending.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error("会话通道已关闭"));
  }
  session.socket.destroy();
  await inspectionContext.exit(() => runDeviceAdb(session.adbPath, session.serial, ["forward", "--remove", `tcp:${session.port}`], 10_000)).catch(() => undefined);
}

/** Routes one provider request over the persistent session; no session means the `content` CLI fallback. */
async function providerCall(adbPath: string, serial: string, packageName: string, method: string, arg: string | null, extras: Record<string, string | boolean> | null, timeoutMs: number, shellQuote = false): Promise<CommandResult> {
  if (sessionSupport.get(sessionKey(serial, packageName)) !== false) {
    const session = await openProviderSession(adbPath, serial, packageName).catch(() => null);
    if (session) {
      const signal = inspectionContext.getStore()?.signal;
      try {
        signal?.throwIfAborted();
        const line = await Promise.race([
          sessionRequest(session, { method, arg, extras: extras ?? {} }, timeoutMs),
          new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason instanceof Error ? signal.reason : new Error("已取消")), { once: true })),
        ]);
        return { code: 0, stdout: Buffer.from(line, "utf8"), stderr: "" };
      } catch (error) {
        // A timeout or abort leaves the line protocol desynced (the device still answers later),
        // so the session is done; the caller's existing failure handling applies.
        await closeProviderSession(session);
        throw error;
      }
    }
  }
  const args = ["-s", serial, "shell", "content", "call", "--uri", `content://${packageName}.inspector`, "--method", method];
  if (arg !== null) args.push("--arg", shellQuote ? `'${arg}'` : arg);
  for (const [name, value] of Object.entries(extras ?? {})) args.push("--extra", `${name}:${typeof value === "boolean" ? "b" : "s"}:${value}`);
  return runCommand(adbPath, args, timeoutMs);
}

export function closeProviderSessions() {
  for (const [key, pending] of [...providerSessions]) {
    providerSessions.delete(key);
    void pending.then((session) => { if (session) void closeProviderSession(session); }).catch(() => undefined);
  }
}

export function captureSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

type CommandResult = {
  code: number | null;
  stdout: Buffer;
  stderr: string;
};

type XmlNode = Record<string, unknown>;

type XmlDocument = {
  hierarchy?: {
    node?: unknown;
    "@_rotation"?: unknown;
  };
};

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  // Keep parser and snapshot-store depth budgets aligned. The iterative
  // normalizer handles the accepted depth without consuming the JS call stack.
  maxNestedTags: MAX_UI_HIERARCHY_DEPTH,
  isArray: (tagName) => tagName === "node",
});

function runCommand(command: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const signal = inspectionContext.getStore()?.signal;
    signal?.throwIfAborted();
    const child = spawn(command, args, { windowsHide: true, signal });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`命令执行超时：${command}`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function addCandidate(candidates: string[], value: string | undefined) {
  if (!value || !existsSync(value) || candidates.includes(value)) return;
  candidates.push(value);
}

function findAdbPath() {
  const adbName = process.platform === "win32" ? "adb.exe" : "adb";
  const candidates: string[] = [];
  const sdkRoots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT];

  for (const sdkRoot of sdkRoots) {
    addCandidate(candidates, sdkRoot ? join(sdkRoot, "platform-tools", adbName) : undefined);
  }

  if (process.platform === "darwin") {
    addCandidate(candidates, join(homedir(), "Library", "Android", "sdk", "platform-tools", adbName));
    addCandidate(candidates, join("/opt/homebrew", "bin", adbName));
    addCandidate(candidates, join("/usr/local", "bin", adbName));
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    addCandidate(candidates, join(localAppData, "Android", "Sdk", "platform-tools", adbName));

    const wingetPackages = join(localAppData, "Microsoft", "WinGet", "Packages");
    try {
      for (const packageName of readdirSync(wingetPackages)) {
        if (packageName.startsWith("Google.PlatformTools_")) {
          addCandidate(candidates, join(wingetPackages, packageName, "platform-tools", adbName));
        }
      }
    } catch {
      // The optional winget location is absent on most non-Windows machines.
    }
  }

  addCandidate(candidates, join(homedir(), "AppData", "Local", "Android", "Sdk", "platform-tools", adbName));
  for (const pathEntry of (process.env.PATH ?? "").split(delimiter)) {
    addCandidate(candidates, join(pathEntry, adbName));
  }

  return candidates[0] ?? null;
}

async function runAdb(adbPath: string, args: string[]) {
  return runCommand(adbPath, args);
}

async function runDeviceAdb(adbPath: string, serial: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS) {
  return runCommand(adbPath, ["-s", serial, ...args], timeoutMs);
}

function commandError(prefix: string, result: CommandResult) {
  const detail = result.stderr.trim();
  return detail ? `${prefix}：${detail}` : prefix;
}

function parseDeviceLine(line: string): DeviceInfo | null {
  const fields = line.trim().split(/\s+/);
  if (fields.length < 2 || fields[0] === "List" || fields[0] === "*") return null;

  const [serial, state, ...metadata] = fields;
  let model: string | null = null;
  let product: string | null = null;
  let transportId: string | null = null;

  for (const field of metadata) {
    const separator = field.indexOf(":");
    if (separator < 0) continue;
    const key = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (key === "model") model = value.replace(/_/g, " ");
    if (key === "product") product = value;
    if (key === "transport_id") transportId = value;
  }

  return { serial, state, model, androidVersion: null, product, transportId };
}

function attributeValue(raw: XmlNode, key: string) {
  const value = raw[`@_${key}`];
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

function attributeBool(raw: XmlNode, key: string, fallback: boolean) {
  const value = attributeValue(raw, key);
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return fallback;
}

function rawAttributes(raw: XmlNode) {
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith("@_")) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
    attributes[key.slice(2)] = String(value);
  }
  return attributes;
}

function parseBounds(raw: string | null): UiBounds | null {
  if (!raw) return null;
  const match = raw.match(/^\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]\s*$/);
  if (!match) return null;

  const [, left, top, right, bottom] = match;
  const values = [Number(left), Number(top), Number(right), Number(bottom)];
  if (!values.every(Number.isSafeInteger)) return null;
  return {
    left: values[0],
    top: values[1],
    right: values[2],
    bottom: values[3],
    raw,
  };
}

function parseNodeIndex(raw: XmlNode) {
  const value = attributeValue(raw, "index");
  if (!value || !/^[0-9]+$/.test(value)) return null;
  const index = Number(value);
  return Number.isSafeInteger(index) ? index : null;
}

function arrayValue(value: unknown): XmlNode[] {
  if (Array.isArray(value)) return value.filter((item): item is XmlNode => Boolean(item && typeof item === "object"));
  if (value && typeof value === "object") return [value as XmlNode];
  return [];
}

function createNormalizedNode(raw: XmlNode, id: string): UiNode {
  const rawBounds = attributeValue(raw, "bounds");
  return {
    id,
    index: parseNodeIndex(raw),
    className: attributeValue(raw, "class"),
    package: attributeValue(raw, "package"),
    text: attributeValue(raw, "text"),
    resourceId: attributeValue(raw, "resource-id"),
    contentDesc: attributeValue(raw, "content-desc"),
    bounds: parseBounds(rawBounds),
    clickable: attributeBool(raw, "clickable", false),
    enabled: attributeBool(raw, "enabled", true),
    focusable: attributeBool(raw, "focusable", false),
    focused: attributeBool(raw, "focused", false),
    scrollable: attributeBool(raw, "scrollable", false),
    selected: attributeBool(raw, "selected", false),
    visibleToUser: attributeBool(raw, "visible-to-user", true),
    attributes: rawAttributes(raw),
    children: [],
  };
}

function normalizeNode(raw: XmlNode, id: string): UiNode {
  const root = createNormalizedNode(raw, id);
  const pending: Array<{ raw: XmlNode; node: UiNode }> = [{ raw, node: root }];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const current = pending[cursor];
    arrayValue(current.raw.node).forEach((child, index) => {
      const node = createNormalizedNode(child, `${current.node.id}/${index}`);
      current.node.children.push(node);
      pending.push({ raw: child, node });
    });
  }
  return root;
}

export function parseUiHierarchy(xml: string) {
  const document = xmlParser.parse(xml) as XmlDocument;
  const rootRaw = arrayValue(document.hierarchy?.node)[0];
  if (!rootRaw) throw new Error("UI hierarchy 中没有找到 node 节点。");
  const rawRotation = document.hierarchy?.["@_rotation"];
  const rotation = typeof rawRotation === "string" && /^[0-3]$/.test(rawRotation) ? Number(rawRotation) : null;
  return { root: normalizeNode(rootRaw, "0"), rotation: isRotation(rotation) ? rotation : null };
}

async function readDisplayFrame(adbPath: string, serial: string) {
  try {
    const result = await runCommand(adbPath, ["-s", serial, "shell", "dumpsys", "input"], 5_000);
    return result.code === 0 ? parseInputDisplay(result.stdout.toString("utf8")) : null;
  } catch {
    // Optional diagnostics must not turn a usable hierarchy into a failed capture.
    return null;
  }
}

async function readAndroidVersion(adbPath: string, serial: string) {
  try {
    const result = await runCommand(adbPath, ["-s", serial, "shell", "getprop", "ro.build.version.release"], 5_000);
    if (result.code !== 0) return null;
    const value = result.stdout.toString("utf8").trim();
    return value || null;
  } catch {
    // Version is display metadata. A slow or restricted getprop must not make
    // an otherwise usable device disappear from the connection screen.
    return null;
  }
}

function countNodes(node: UiNode): number {
  let count = 0;
  const pending = [node];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    count += 1;
    pending.push(...pending[cursor].children);
  }
  return count;
}

type ForegroundTarget = { packageName: string; activityName: string; component: string };

function foregroundTarget(output: string): ForegroundTarget | null {
  const match = output.match(/(?:mResumedActivity|topResumedActivity)[:=].*?\bu\d+\s+([^/\s]+)\/([^\s}\]]+)/);
  if (!match) return null;
  return { packageName: match[1], activityName: match[2], component: `${match[1]}/${match[2]}` };
}

function targetActivitySection(output: string, target: ForegroundTarget) {
  const marker = `ACTIVITY ${target.component} `;
  const start = output.indexOf(marker);
  if (start < 0) throw new Error("前台 Activity 已切换，请重新采集。");
  const next = output.indexOf("\n  ACTIVITY ", start + marker.length);
  return output.slice(start, next < 0 ? undefined : next);
}

export function hasActivityHierarchy(section: string, target: ForegroundTarget) {
  if (section.includes("org.qtproject.qt.android.")) return true;
  try { debugViewTree(section, target); return true; }
  catch (error) {
    if (error instanceof Error && /无法从 Debug App 读取 View Hierarchy|未读取到 Debug View 节点/.test(error.message)) return false;
    throw error;
  }
}

function appBounds(section: string): UiBounds | null {
  const match = section.match(/mAppBounds=Rect\((-?\d+),\s*(-?\d+)\s*-\s*(-?\d+),\s*(-?\d+)\)/);
  if (!match) return null;
  const [, left, top, right, bottom] = match.map(Number);
  return { left, top, right, bottom, raw: `[${left},${top}][${right},${bottom}]` };
}

export function debugViewTree(section: string, target: ForegroundTarget): UiNode {
  const hierarchy = section.split("View Hierarchy:")[1]?.split("\n    Looper")[0];
  if (!hierarchy) throw new Error("无法从 Debug App 读取 View Hierarchy。");
  if (hierarchy.includes("AndroidComposeView")) throw new Error("当前版本尚未支持 Compose Debug 控件树。");

  const rootBounds = appBounds(section);
  const root: UiNode = {
    id: "0",
    index: 0,
    className: target.activityName,
    package: target.packageName,
    text: null,
    resourceId: null,
    contentDesc: null,
    bounds: rootBounds,
    clickable: false,
    enabled: true,
    focusable: false,
    focused: false,
    scrollable: false,
    selected: false,
    visibleToUser: true,
    attributes: { "inspection-source": "debug-view" },
    children: [],
  };
  const stack: Array<{ indent: number; node: UiNode; left: number; top: number }> = [{ indent: -1, node: root, left: 0, top: 0 }];

  for (const line of hierarchy.split(/\r?\n/)) {
    const match = line.match(/^(\s+)([^\s{]+)\{([^}]*)\}(.*)$/);
    const decor = line.match(/^(\s+)(DecorView)@([0-9a-f]+)\[[^\r\n]*\]\s*$/i);
    const identity = match ?? decor;
    if (!identity) continue;
    const indent = identity[1].length;
    const className = identity[2].split("@")[0];
    const details = match?.[3] ?? "";
    const coordinates = details.match(/\s(-?\d+),(-?\d+)-(-?\d+),(-?\d+)(?:\s|$)/);
    if (!coordinates && !decor) continue;
    while (stack.length > 1 && stack.at(-1)!.indent >= indent) stack.pop();
    const parent = stack.at(-1)!;
    const localLeft = Number(coordinates?.[1] ?? 0);
    const localTop = Number(coordinates?.[2] ?? 0);
    const left = parent.left + localLeft;
    const top = parent.top + localTop;
    const right = parent.left + Number(coordinates?.[3] ?? 0);
    const bottom = parent.top + Number(coordinates?.[4] ?? 0);
    const flags = details.trim().split(/\s+/)[1] ?? "";
    const resourceId = details.match(/#\S+\s+([^\s}]+:id\/[^\s}]+)/)?.[1] ?? null;
    const text = match?.[4].match(/^\(([^)]*)\)/)?.[1] || null;
    const index = parent.node.children.length;
    const node: UiNode = {
      id: `${parent.node.id}/${index}`,
      index,
      className,
      package: target.packageName,
      text,
      resourceId,
      contentDesc: null,
      bounds: coordinates ? { left, top, right, bottom, raw: `[${left},${top}][${right},${bottom}]` } : null,
      clickable: flags.includes("C"),
      enabled: Boolean(decor) || flags.includes("E"),
      focusable: flags.includes("F"),
      focused: false,
      scrollable: className.includes("Scroll") || className.includes("Recycler"),
      selected: false,
      visibleToUser: Boolean(decor) || flags.startsWith("V"),
      attributes: { "inspection-source": "debug-view", "view-flags": flags, "view-ref": `${className}@${decor?.[3] ?? details.trim().split(/\s+/)[0]}` },
      children: [],
    };
    parent.node.children.push(node);
    stack.push({ indent, node, left, top });
  }
  if (root.children.length === 0) throw new Error("未读取到 Debug View 节点。");
  return root;
}

function viewLayerName(node: UiNode) {
  if (node.attributes?.["debug-layer-name"]) return node.attributes["debug-layer-name"];
  if (node.resourceId?.includes(":id/")) return `id/${node.resourceId.split(":id/")[1]}`;
  const className = node.className ?? "";
  return className.slice(className.lastIndexOf(".") + 1);
}

// Exact framework classes only: a custom subclass may still own a Surface.
const ordinaryViewClasses = new Set([
  "android.view.View", "android.view.ViewGroup", "android.widget.TextView", "android.widget.ImageView",
  "android.widget.FrameLayout", "android.widget.LinearLayout", "android.widget.RelativeLayout",
  "android.widget.Button", "android.widget.EditText", "android.widget.ImageButton",
  "android.widget.ProgressBar", "android.widget.ScrollView", "android.widget.HorizontalScrollView",
]);
export function needsViewBitmapFallback(node: UiNode, verifiedOwnBitmap = false, pureLayout = false) {
  if (pureLayout) return false;
  return node.layerImageStatus !== "captured" || node.attributes?.["skip-draw"] === "true" || !verifiedOwnBitmap && !ordinaryViewClasses.has(node.className ?? "");
}

export function attachViewLayerImages(root: UiNode, layers: readonly CapturedViewLayer[], windowOrigin = { x: 0, y: 0 }) {
  const nodes: UiNode[] = [];
  const stack = [...root.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    nodes.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]);
  }

  // DDMS CAPTURE_LAYERS has no identity for most records. Never resolve a
  // same-name/same-bounds collision by traversal order: it can swap pixels.
  const key = (name: string, x: number, y: number, width: number, height: number) => JSON.stringify([name, x, y, width, height]);
  const candidates = new Map<string, UiNode[]>();
  for (const node of nodes) {
    delete node.layerImageDataUrl;
    delete node.layerImageSize;
    delete node.layerImageEmpty;
    node.layerImageStatus = node.visibleToUser ? "unavailable" : "hidden";
    if (!node.visibleToUser || !node.bounds) continue;
    const { left, top, right, bottom } = node.bounds;
    // Android omits PFLAG_SKIP_DRAW views from anonymous CAPTURE_LAYERS.
    // Keep explicit identities usable; Surface/Texture buffers are captured separately.
    const names = [node.attributes?.["view-ref"]];
    if (node.attributes?.["skip-draw"] !== "true") names.push(viewLayerName(node));
    for (const name of new Set(names.filter((value): value is string => Boolean(value)))) {
      const id = key(name, left, top, right - left, bottom - top);
      candidates.set(id, [...(candidates.get(id) ?? []), node]);
    }
  }
  const counts = new Map<string, number>();
  for (const layer of layers) {
    if (!layer.visible || !layer.imageDataUrl || layer.width < 1 || layer.height < 1) continue;
    const id = key(layer.viewRef ?? layer.name, layer.x + windowOrigin.x, layer.y + windowOrigin.y, layer.width, layer.height);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let attached = 0;
  for (const layer of layers) {
    if (!layer.visible || !layer.imageDataUrl || layer.width < 1 || layer.height < 1) continue;
    const id = key(layer.viewRef ?? layer.name, layer.x + windowOrigin.x, layer.y + windowOrigin.y, layer.width, layer.height);
    const matches = candidates.get(id) ?? [];
    if (matches.length !== 1 || counts.get(id) !== 1) {
      for (const node of matches) if (node.layerImageStatus !== "captured") node.layerImageStatus = "ambiguous";
      continue;
    }
    const node = matches[0];
    if (node.layerImageStatus === "captured") continue;
    node.layerImageDataUrl = layer.imageDataUrl;
    node.layerImageSize = { width: layer.width, height: layer.height };
    node.layerImageStatus = "captured";
    attached += 1;
  }
  // Android rounds getLocationInWindow and getLocationOnScreen separately.
  // Accept a one-pixel drift only when both the View and bitmap are unique.
  const nearbyKeys = (name: string, x: number, y: number, width: number, height: number) => {
    const keys: string[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) keys.push(key(name, x + dx, y + dy, width, height));
    return keys;
  };
  for (const layer of layers) {
    if (!layer.visible || !layer.imageDataUrl || layer.width < 1 || layer.height < 1) continue;
    const name = layer.viewRef ?? layer.name, x = layer.x + windowOrigin.x, y = layer.y + windowOrigin.y;
    if (candidates.has(key(name, x, y, layer.width, layer.height))) continue;
    const matches = [...new Set(nearbyKeys(name, x, y, layer.width, layer.height).flatMap((id) => candidates.get(id) ?? []))];
    if (matches.length !== 1 || matches[0].layerImageStatus !== "unavailable") continue;
    const node = matches[0], bounds = node.bounds!;
    if (nearbyKeys(name, bounds.left, bounds.top, layer.width, layer.height).reduce((sum, id) => sum + (counts.get(id) ?? 0), 0) !== 1) continue;
    node.layerImageDataUrl = layer.imageDataUrl;
    node.layerImageSize = { width: layer.width, height: layer.height };
    node.layerImageStatus = "captured";
    attached += 1;
  }
  return attached;
}

export function matchSdkVisibleLayers(root: UiNode, layers: readonly CapturedViewLayer[]) {
  const nodes = new Map<string, UiNode>();
  const pending = [...root.children];
  while (pending.length) {
    const node = pending.pop()!;
    const ref = node.attributes?.["view-ref"];
    if (ref) nodes.set(ref, node);
    pending.push(...node.children);
  }
  const seen = new Set<string>();
  const matched: CapturedViewLayer[] = [];
  let moved = 0, unmatched = 0;
  for (const layer of layers) {
    const node = nodes.get(layer.name), bounds = node?.bounds;
    if (seen.has(layer.name)) throw new Error("SDK 可见层对象重复");
    seen.add(layer.name);
    if (!node?.visibleToUser || !bounds || layer.width !== bounds.right - bounds.left || layer.height !== bounds.bottom - bounds.top) {
      unmatched++;
      continue;
    }
    if (Math.abs(layer.x - bounds.left) > 1 || Math.abs(layer.y - bounds.top) > 1) moved++;
    else matched.push(layer);
  }
  // ponytail: a mostly stale batch uses DDMS; tune the majority cutoff from multi-device timings.
  if (matched.length * 2 < layers.length) throw new Error(`SDK 可见层中 ${moved} 个移动、${unmatched} 个尺寸或状态变化，已回退完整抓图`);
  return { matched, moved, unmatched, refs: new Set(nodes.keys()) };
}

async function captureSdkVisibleLayers(adbPath: string, serial: string, packageName: string, root: UiNode, onPartial?: (layers: CapturedViewLayer[]) => void | Promise<void>, withTree?: { onTree: (value: unknown) => Promise<void>; onMissing: () => void; treeReady?: Promise<void> }) {
  const before = await checkedDebugTarget(adbPath, serial, packageName);
  const processId = root.attributes?.["debug-process-id"];
  const rootRef = root.children[0]?.attributes?.["view-ref"];
  if (!processId || !rootRef || String(await singleAppPid(adbPath, serial, packageName)) !== processId) throw new Error("SDK 进程或根控件已变化");
  const fileName = "no_backup/inspector-visible-layers.bin";
  const nonce = randomUUID().replace(/-/g, "").slice(0, 16);
  const treeFileName = `no_backup/inspector-tree-${nonce}.json`;
  const mergedTree = Boolean(withTree);
  const treeReady = withTree?.treeReady;
  try {
    const callStarted = performance.now();
    const priorityViewRef = inspectionContext.getStore()?.priorityViewRef;
    const extras: Record<string, string | boolean> = {};
    if (withTree) extras.withTree = true;
    if (priorityViewRef) extras.priorityViewRef = priorityViewRef;
    const request = providerCall(adbPath, serial, packageName, "capture-visible", nonce, Object.keys(extras).length ? extras : null, 65_000)
      .then((reply) => ({ reply, error: null as unknown }), (error: unknown) => ({ reply: null, error }));
    // ponytail: partial previews poll the growing files while the call runs; retune the cadence from device samples.
    let partialCount = 0, previews = 0, polls = 0, failures = 0;
    let treeLanded = false;
    const treeDeadline = callStarted + 4_000;
    const partialEnabled = Boolean(onPartial);
    while ((withTree && !treeLanded || onPartial && previews < 3) && polls++ < 16) {
      const result = await Promise.race([request, wait(600, undefined, { signal: inspectionContext.getStore()?.signal }).then(() => null)]);
      if (result) break;
      if (withTree && !treeLanded && performance.now() > treeDeadline) {
        // The provider ignored withTree (older SDK) or could not publish it; the classic fetch takes over.
        console.log("[visible] merged tree missing; classic fetch");
        withTree.onMissing();
        withTree = undefined;
      }
      if (withTree && !treeLanded) {
        // The tree file carries the call nonce, so a present file is this call's fresh write.
        const treeChunk = await runDeviceAdb(adbPath, serial, ["exec-out", "run-as", packageName, "head", "-c", "4000001", treeFileName], 5_000);
        // A missing file still exits 0 with the error text on stdout: only an object that parses counts.
        let treeValue: unknown;
        if (treeChunk.code === 0 && treeChunk.stdout[0] === 0x7b && treeChunk.stdout.length <= 4_000_000) {
          try { treeValue = JSON.parse(treeChunk.stdout.toString("utf8")) as unknown; } catch { treeValue = undefined; }
        }
        if (treeValue === undefined) continue;
        treeLanded = true;
        console.log("[visible] merged tree landed");
        try {
          await withTree.onTree(treeValue);
        } catch (error) {
          // Only the SDK hierarchy is skipped; the layers below stay usable.
          console.log(`[visible] merged tree rejected: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // The tree phase must settle before matching: both the mid-call adopt and the classic fallback rewrite refs.
      if (withTree && !treeLanded) continue;
      if (!onPartial) continue;
      try {
        const chunk = await runDeviceAdb(adbPath, serial, ["exec-out", "run-as", packageName, "head", "-c", "12000001", `${fileName}.tmp`], 5_000);
        if (chunk.code !== 0) continue;
        const layers = parseCapturedViewLayerPrefix(chunk.stdout, nonce);
        if (layers.length < (partialCount ? partialCount + 120 : 24)) continue;
        const { matched } = matchSdkVisibleLayers(root, layers);
        const current = await checkedDebugTarget(adbPath, serial, packageName);
        if (current.component !== before.component || current.windowId !== before.windowId
            || String(await singleAppPid(adbPath, serial, packageName)) !== processId) throw new Error("SDK 分段采集期间窗口或进程已变化");
        inspectionContext.getStore()?.signal?.throwIfAborted();
        await onPartial(matched);
        partialCount = layers.length;
        previews++;
        failures = 0;
      } catch (error) {
        inspectionContext.getStore()?.signal?.throwIfAborted();
        // A partial file is optional. The complete SHA-256-checked path remains authoritative,
        // so a transient read keeps retrying instead of disabling the previews for good.
        failures++;
        if (failures <= 3) console.log(`[visible] partial ${failures} failed: ${error instanceof Error ? error.message : String(error)}`);
        if (failures >= 3) onPartial = undefined;
      }
    }
    if (partialEnabled) console.log(`[visible] partial previews=${previews} polls=${polls} failures=${failures} records=${partialCount}`);
    const outcome = await request;
    // Every exit path must settle the tree phase: no landed tree means the classic fetch takes over.
    if (withTree && !treeLanded) {
      console.log("[visible] merged tree missing; classic fetch");
      withTree.onMissing();
    }
    if (treeReady) {
      // Validate and match against the final refs: the caller adopts the tree after settling the phase.
      await treeReady;
      inspectionContext.getStore()?.signal?.throwIfAborted();
    }
    if (outcome.error) throw outcome.error;
    const reply = outcome.reply!;
    const callMs = Math.round(performance.now() - callStarted);
    const output = reply.stdout.toString("utf8");
    const field = (name: string) => new RegExp(`\\b${name}=([^,}\\]]+)`).exec(output)?.[1];
    const instance = field("processInstance"), sha256 = field("sha256"), count = Number(field("count")), selected = Number(field("selected")), empty = Number(field("empty")), bytes = Number(field("bytes"));
    const renderMs = Number(field("renderMs")), encodeMs = Number(field("encodeMs")), durationMs = Number(field("durationMs"));
    const specialValue = field("specialRefs");
    const specialEntries = specialValue === "-" ? [] : specialValue?.split(";") ?? [];
    const specialRefs = new Set(specialEntries.map((entry) => entry.slice(2)));
    const pureRefs = parsePureViewRefs(field("pureRefs"));
    // Read the ref from the live tree: the caller may have rebuilt it from the SDK hierarchy while this call ran.
    if (reply.code !== 0 || field("result") !== "ok" || field("rootRef") !== (root.children[0]?.attributes?.["view-ref"] ?? "") || (field("nonce") && field("nonce") !== nonce)
        || !instance || !/^[0-9a-f-]{36}$/i.test(instance) || !sha256 || !/^[a-f0-9]{64}$/.test(sha256)
        || !Number.isSafeInteger(count) || count < 1 || count > 5000 || !Number.isSafeInteger(selected) || selected < count || selected > 5000
        || !Number.isSafeInteger(empty) || empty < 0 || selected !== count + empty || !Number.isSafeInteger(bytes) || bytes < 9 || bytes > 64_000_000
        || ![renderMs, encodeMs, durationMs].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 65_000)
        || !specialValue || specialEntries.length > 32 || specialRefs.size !== specialEntries.length
        || !specialEntries.every((entry) => /^[ST]:[\w.$]+@[0-9a-f]{1,8}$/i.test(entry))) {
      throw new Error(`SDK 可见层抓取失败：${field("error") ?? "响应无效"}`);
    }
    const readStarted = performance.now();
    const file = await runDeviceAdb(adbPath, serial, ["exec-out", "run-as", packageName, "head", "-c", "64000001", fileName]);
    const readMs = Math.round(performance.now() - readStarted);
    if (file.code !== 0 || file.stdout.length !== bytes || createHash("sha256").update(file.stdout).digest("hex") !== sha256) throw new Error("SDK 可见层文件校验失败");
    const layers = parseCapturedViewLayers(file.stdout);
    if (layers.length !== count || !layers.every((layer) => layer.visible && layer.imageDataUrl && layer.name.includes("@"))) throw new Error("SDK 可见层记录不完整");
    const { matched, moved, unmatched, refs } = matchSdkVisibleLayers(root, layers);
    if ([...specialRefs].some((ref) => !refs.has(ref))) throw new Error("SDK 特殊画面控件与当前控件树不一致");
    if ([...pureRefs].some((ref) => !refs.has(ref) || specialRefs.has(ref))) throw new Error("SDK 纯布局控件与当前控件树不一致");
    const after = await checkedDebugTarget(adbPath, serial, packageName);
    if (before.component !== after.component || before.windowId !== after.windowId || String(await singleAppPid(adbPath, serial, packageName)) !== processId) throw new Error("SDK 采集期间窗口或进程已变化");
    root.attributes = { ...root.attributes, "sdk-visible-process-instance": instance, "sdk-visible-images": String(matched.length), "sdk-visible-empty": String(empty), "sdk-visible-moved": String(moved), "sdk-visible-unmatched": String(unmatched), "sdk-pure-refs": String(pureRefs.size) };
    const treeField = field("tree");
    return { layers: matched, specialRefs, pureRefs, timing: { callMs, readMs, renderMs, encodeMs, durationMs }, tree: mergedTree ? { status: treeField === "ok" ? "ok" as const : treeField === undefined ? "unsupported" as const : "failed" as const } : null };
  } finally {
    await inspectionContext.exit(() => runDeviceAdb(adbPath, serial, ["shell", "run-as", packageName, "rm", "-f", ...(mergedTree ? [fileName, treeFileName] : [fileName])])).catch(() => undefined);
  }
}

export function parsePureViewRefs(value: string | undefined): Set<string> {
  if (value === undefined || value === "-") return new Set(); // Older SDKs did not report this hint.
  const entries = value.split(";");
  const refs = new Set(entries);
  if (value.length > 16_000 || refs.size !== entries.length || !entries.every((entry) => /^[\w.$]+@[0-9a-f]{1,8}$/i.test(entry))) {
    throw new Error("SDK 纯布局控件身份无效");
  }
  return refs;
}

/** Batch-capture one pre-selected View set through the SDK; replaces the per-node JDWP walk. */
async function captureSdkRefLayers(adbPath: string, serial: string, packageName: string, root: UiNode, refs: string[]) {
  const processInstance = root.attributes?.["sdk-visible-process-instance"];
  const rootRef = root.children[0]?.attributes?.["view-ref"];
  if (!processInstance || !rootRef) throw new Error("SDK 补齐缺少进程或根控件身份");
  const fileName = "no_backup/inspector-ref-layers.bin";
  const nonce = randomUUID().replace(/-/g, "").slice(0, 16);
  try {
    const callStarted = performance.now();
    // ponytail: single quotes survive the device shell so $-class names reach content call intact; the session path sends the raw arg.
    const reply = await providerCall(adbPath, serial, packageName, "capture-refs", refs.join(";"), { nonce }, 30_000, true);
    const callMs = Math.round(performance.now() - callStarted);
    const output = reply.stdout.toString("utf8");
    const field = (name: string) => new RegExp(`\\b${name}=([^,}\\]]+)`).exec(output)?.[1];
    const instance = field("processInstance"), sha256 = field("sha256"), count = Number(field("count")), requested = Number(field("requested")), bytes = Number(field("bytes"));
    const renderMs = Number(field("renderMs")), encodeMs = Number(field("encodeMs")), durationMs = Number(field("durationMs"));
    const specialValue = field("special"), failuresValue = field("failures"), emptyValue = field("empty");
    if (reply.code !== 0 || field("result") !== "ok" || field("nonce") !== nonce || field("rootRef") !== rootRef
        || instance !== processInstance || !sha256 || !/^[a-f0-9]{64}$/.test(sha256)
        || !Number.isSafeInteger(count) || count < 0 || count > refs.length || requested !== refs.length
        || !Number.isSafeInteger(bytes) || bytes < 9 || bytes > 64_000_000
        || ![renderMs, encodeMs, durationMs].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 30_000)
        || (specialValue !== undefined && specialValue !== "-" && specialValue.length > 6_000)
        || (failuresValue !== undefined && failuresValue !== "-" && failuresValue.length > 16_000)
        || (emptyValue !== undefined && emptyValue !== "-" && emptyValue.length > 16_000)) {
      throw new Error(`SDK 补齐抓取失败：${field("error") ?? "响应无效"}`);
    }
    const wanted = new Set(refs);
    const specialEntries = specialValue === undefined ? null : specialValue === "-" ? [] : specialValue.split(";");
    if (!specialEntries || specialEntries.length > refs.length || !specialEntries.every((entry) => /^[ST]:[\w.$]+@[0-9a-f]{1,8}$/i.test(entry) && wanted.has(entry.slice(2)))) {
      throw new Error("SDK 补齐特殊画面清单无效");
    }
    const kinds = new Map<string, "own" | "texture" | "surface">(specialEntries.map((entry) => [entry.slice(2), entry[0] === "S" ? "surface" as const : "texture" as const]));
    const pure = [...parsePureViewRefs(field("pure"))];
    if (pure.some((ref) => !wanted.has(ref) || kinds.has(ref))) throw new Error("SDK 补齐纯布局清单无效");
    const failures = new Map<string, string>();
    for (const entry of failuresValue === undefined || failuresValue === "-" ? [] : failuresValue.split(";")) {
      const at = entry.indexOf(":");
      const ref = at < 0 ? "" : entry.slice(0, at), reason = at < 0 ? "" : entry.slice(at + 1);
      if (!wanted.has(ref) || !reason || reason.length > 200 || failures.has(ref)) throw new Error("SDK 补齐失败清单无效");
      failures.set(ref, reason);
    }
    const emptyRefs = emptyValue === undefined || emptyValue === "-" ? [] : emptyValue.split(";");
    if (emptyRefs.some((ref) => !wanted.has(ref))) throw new Error("SDK 补齐空白清单无效");
    const readStarted = performance.now();
    const file = await runDeviceAdb(adbPath, serial, ["exec-out", "run-as", packageName, "head", "-c", "64000001", fileName]);
    const readMs = Math.round(performance.now() - readStarted);
    if (file.code !== 0 || file.stdout.length !== bytes || createHash("sha256").update(file.stdout).digest("hex") !== sha256) throw new Error("SDK 补齐文件校验失败");
    const layers = parseCapturedViewLayers(file.stdout);
    if (layers.length !== count || !layers.every((layer) => layer.visible && layer.imageDataUrl && layer.name.includes("@") && wanted.has(layer.name))) throw new Error("SDK 补齐记录不完整");
    const empty = new Set(emptyRefs);
    const images = new Map<string, { width: number; height: number; imageDataUrl: string; kind: "own" | "texture" | "surface"; empty: boolean }>();
    const seen = new Set<string>();
    for (const layer of layers) {
      if (seen.has(layer.name)) throw new Error("SDK 补齐对象重复");
      seen.add(layer.name);
      images.set(layer.name, { width: layer.width, height: layer.height, imageDataUrl: layer.imageDataUrl!, kind: kinds.get(layer.name) ?? "own", empty: empty.has(layer.name) });
    }
    for (const ref of pure) seen.add(ref);
    for (const ref of failures.keys()) seen.add(ref);
    if (seen.size !== refs.length || refs.some((ref) => !seen.has(ref))) throw new Error("SDK 补齐结果缺少控件");
    return { images, failures, kinds, skipDraw: new Set(pure), timing: { requested: refs.length, callMs, readMs, renderMs, encodeMs, durationMs } };
  } finally {
    await inspectionContext.exit(() => runDeviceAdb(adbPath, serial, ["shell", "run-as", packageName, "rm", "-f", fileName])).catch(() => undefined);
  }
}

type InspectionPreview = ((phase: "tree" | "layers") => void | Promise<void>) & { beginTreeScreen?: () => Promise<void> };

async function captureDebugViewImages(adbPath: string, serial: string, packageName: string, root: UiNode, stage: (name: string) => void, preview?: InspectionPreview, timings?: Record<string, number>): Promise<{ imageCount: number; finalScreen: Promise<Awaited<ReturnType<typeof captureScreen>> | null> | null }> {
  const pid = await runDeviceAdb(adbPath, serial, ["shell", "pidof", packageName]);
  const processId = pid.stdout.toString("utf8").trim().split(/\s+/)[0];
  if (pid.code !== 0 || !/^\d+$/.test(processId)) return { imageCount: 0, finalScreen: null };
  root.attributes = { ...root.attributes, "debug-process-id": processId };
  // Let registration return its allocated port even if cancellation arrives;
  // killing the client midway could leave an unknown ADB server-side forward.
  const forwarded = await inspectionContext.exit(() => runDeviceAdb(adbPath, serial, ["forward", "tcp:0", `jdwp:${processId}`]));
  const port = forwarded.stdout.toString("utf8").trim();
  if (forwarded.code !== 0 || !/^\d+$/.test(port)) return { imageCount: 0, finalScreen: null };
  try {
    let windowName = "";
    const useVisibleSdk = () => inspectionContext.getStore()?.preferVisibleSdk === true;
    const batchTiming = ({ waitMs, readMs, parseMs, bytes, layers: layerCount, images }: { waitMs: number; readMs: number; parseMs: number; bytes: number; layers: number; images: number }) => {
      if (timings) {
        timings["DDMS 等待首包"] = Math.round(waitMs);
        timings["DDMS 接收包体"] = Math.round(readMs);
        timings["DDMS 解析图片"] = Math.round(parseMs);
      }
      root.attributes = { ...root.attributes, "ddms-batch-bytes": String(bytes), "ddms-batch-layers": String(layerCount), "ddms-batch-images": String(images) };
    };
    const rootRefs = () => root.children.map((node) => node.attributes?.["view-ref"]).filter((value): value is string => Boolean(value));
    let layers: CapturedViewLayer[] = [];
    // C: on SDK pages, adopt the SDK hierarchy first; the DDMS property export stays the compatibility path.
    const store = inspectionContext.getStore();
    const sdkFirstCandidate = Boolean(store?.onViewTreeReady)
      && (store?.preferVisibleSdk === true || store?.preferVisibleSdk === undefined && countNodes(root) >= 200);
    let sdkFirst = false;
    let mergedVisible: Promise<Awaited<ReturnType<typeof captureSdkVisibleLayers>>> | null = null;
    if (sdkFirstCandidate) {
      try {
        windowName = await probeWindowName(Number(port), rootRefs(), store?.signal);
        root.attributes = { ...root.attributes, "debug-window-name": windowName };
        // The preview screenshot and the SDK tree fetch are independent, so run them together:
        // the preview then carries the adopted tree without paying both waits back to back.
        const pendingPreviewScreen = preview?.beginTreeScreen?.();
        stage("核对 SDK 控件树");
        if (mergedTreeSupport.get(`${serial}|${packageName}`) === false) {
          await store!.onViewTreeReady!(packageName, root, "adopt");
        } else {
          // D: one content call publishes the SDK tree first and then renders the layers; the tree
          // is adopted mid-call so the partial previews still match against the final hierarchy.
          let settleTree!: (state: "landed" | "missing") => void;
          const treePhase = new Promise<"landed" | "missing">((resolve) => { settleTree = resolve; });
          // The merged call validates its reply against the adopted tree; resolve once the tree is final.
          let settleTreeReady!: () => void;
          const treeReady = new Promise<void>((resolve) => { settleTreeReady = resolve; });
          const treeFallback = (error: unknown) => {
            store?.signal?.throwIfAborted();
            if (error instanceof Error && /^(App 正在初始化|SDK 控件树连续超时)/.test(error.message)) throw error;
            // ponytail: adoption failures fall back to the unchanged DDMS export, which re-runs its own checks.
            root.attributes = { ...root.attributes, "sdk-first-fallback": error instanceof Error ? error.message : "采集失败" };
          };
          mergedVisible = captureSdkVisibleLayers(adbPath, serial, packageName, root, preview ? async (partial) => {
            attachViewLayerImages(root, partial);
            await preview("layers");
          } : undefined, {
            treeReady,
            onTree: async (value) => {
              try {
                await store!.onViewTreeReady!(packageName, root, "adopt", value);
              } catch (error) {
                treeFallback(error);
              } finally {
                settleTree("landed");
                settleTreeReady();
              }
            },
            onMissing: () => settleTree("missing"),
          });
          // The layer phase below re-awaits the same promise; a failed call must still unblock the tree phase.
          mergedVisible.catch(() => settleTree("missing"));
          if (await treePhase === "missing") {
            // The provider ignored withTree (older SDK) or failed to publish it: classic fetch.
            try {
              await store!.onViewTreeReady!(packageName, root, "adopt");
            } catch (error) {
              treeFallback(error);
            } finally {
              settleTreeReady();
            }
          }
        }
        sdkFirst = useVisibleSdk();
        await pendingPreviewScreen;
        await preview?.("tree");
      } catch (error) {
        store?.signal?.throwIfAborted();
        sdkFirst = false;
        if (error instanceof Error && /^(App 正在初始化|SDK 控件树连续超时)/.test(error.message)) throw error;
        // ponytail: probe or adoption failures fall back to the unchanged DDMS export, which re-runs its own checks.
        root.attributes = { ...root.attributes, "sdk-first-fallback": error instanceof Error ? error.message : "采集失败" };
      }
    }
    if (sdkFirst) {
      stage("SDK 抓取独立画面");
    } else {
      // The merged call owns the provider while it renders; settle it before the DDMS export.
      if (mergedVisible) await mergedVisible.catch(() => undefined);
      layers = await captureViewLayers(Number(port), {
        rootRefs: rootRefs(),
        onHierarchy: async (dump, name) => { applyViewProperties(root, dump, true); windowName = name; root.attributes = { ...root.attributes, "debug-window-name": name }; await preview?.("tree"); stage("核对 SDK 控件树"); await inspectionContext.getStore()?.onViewTreeReady?.(packageName, root); stage(useVisibleSdk() ? "SDK 抓取独立画面" : "DDMS 批量抓图"); },
        onBatchTiming: batchTiming,
        skipImages: useVisibleSdk,
        signal: inspectionContext.getStore()?.signal,
      });
    }
    let sdkVisible = false;
    let specialRefs = new Set<string>();
    let pureRefs = new Set<string>();
    if (useVisibleSdk()) {
      try {
        const started = performance.now();
        const streamVersion = root.attributes?.["sdk-visible-stream"] ?? "";
        if (!mergedVisible && preview && !["1", "2"].includes(streamVersion)) console.log(`[visible] partial previews disabled (stream=${streamVersion || "missing"})`);
        const visible = mergedVisible ? await mergedVisible : await captureSdkVisibleLayers(adbPath, serial, packageName, root, preview && ["1", "2"].includes(streamVersion) ? async (partial) => {
          attachViewLayerImages(root, partial);
          await preview("layers");
        } : undefined);
        if (visible.tree?.status === "unsupported") mergedTreeSupport.set(`${serial}|${packageName}`, false);
        layers = visible.layers;
        specialRefs = visible.specialRefs;
        pureRefs = visible.pureRefs;
        if (timings) Object.assign(timings, {
          "SDK 可见层图": Math.round(performance.now() - started),
          "SDK 设备绘制": visible.timing.renderMs,
          "SDK 图像编码": visible.timing.encodeMs,
          "SDK 设备总耗时": visible.timing.durationMs,
          "SDK 调用往返": visible.timing.callMs,
          "SDK 文件读取": visible.timing.readMs,
        });
        sdkVisible = true;
      } catch (error) {
        inspectionContext.getStore()?.signal?.throwIfAborted();
        // A failed merged call falls back to the classic two-call flow from the next capture on.
        if (mergedVisible) mergedTreeSupport.set(`${serial}|${packageName}`, false);
        attachViewLayerImages(root, []);
        root.attributes = { ...root.attributes, "sdk-visible-fallback": error instanceof Error ? error.message : "采集失败" };
        stage("DDMS 回退抓图");
        layers = await captureViewLayers(Number(port), {
          rootRefs: root.children.map((node) => node.attributes?.["view-ref"]).filter((value): value is string => Boolean(value)),
          onHierarchy: () => undefined, onBatchTiming: batchTiming, signal: inspectionContext.getStore()?.signal,
        });
      }
    }
    // DDMS images use window coordinates; the restored tree uses screen coordinates.
    const windowBounds = root.children[0].bounds;
    const matchStarted = performance.now();
    let count = attachViewLayerImages(root, layers, sdkVisible ? { x: 0, y: 0 } : { x: windowBounds?.left ?? 0, y: windowBounds?.top ?? 0 });
    if (timings) timings["DDMS 匹配控件"] = Math.round(performance.now() - matchStarted);
    await preview?.("layers");
    // The missing-bitmap fallback and the final screenshot are independent: capture the screen
    // while the fallback call runs instead of paying both waits back to back.
    const finalScreen: Promise<Awaited<ReturnType<typeof captureScreen>> | null> = (async () => {
      try {
        const signal = captureSignal(inspectionContext.getStore()?.signal, FINAL_SCREEN_TIMEOUT_MS);
        return await inspectionContext.run({ ...(inspectionContext.getStore() ?? {}), signal }, () => captureScreen(adbPath, serial));
      } catch {
        inspectionContext.getStore()?.signal?.throwIfAborted();
        return null;
      }
    })();
    const fallback: UiNode[] = [];
    const pending = [root];
    while (pending.length) {
      const node = pending.pop()!;
      if (!node.visibleToUser) continue;
      if (node.attributes?.["view-ref"] && pureRefs.has(node.attributes["view-ref"]) && node.layerImageStatus !== "captured") {
        node.attributes["skip-draw"] = "true";
        node.layerImageStatus = "unavailable";
      }
      const bounds = node.bounds;
      if (node.attributes?.["view-ref"] && needsViewBitmapFallback(node, sdkVisible && !specialRefs.has(node.attributes["view-ref"]), pureRefs.has(node.attributes["view-ref"])) && bounds && bounds.right > bounds.left && bounds.bottom > bounds.top && bounds.right > 0 && bounds.bottom > 0 && bounds.left < (root.bounds?.right ?? Infinity) && bounds.top < (root.bounds?.bottom ?? Infinity)) {
        if ((bounds.right - bounds.left) * (bounds.bottom - bounds.top) > 4_000_000) {
          if (!node.layerImageDataUrl) {
            node.layerImageStatus = "failed";
            node.attributes["image-capture-error"] = "控件位图尺寸超过 400 万像素上限";
          }
        } else fallback.push(node);
      }
      pending.push(...node.children);
    }
    if (fallback.length) {
      stage("补齐独立背景与视频画面");
      try {
        fallback.sort((a, b) => Number(b.layerImageStatus === "ambiguous") - Number(a.layerImageStatus === "ambiguous"));
        const requested = fallback.map((node) => node.attributes!["view-ref"]);
        let outcome: {
          images: Map<string, { width: number; height: number; imageDataUrl: string; kind: "own" | "texture" | "surface"; empty: boolean }>;
          failures: Map<string, string>;
          kinds: Map<string, "own" | "texture" | "surface">;
          skipDraw: Set<string>;
          requested: number;
          skipped: number;
          source: "sdk" | "jdwp";
        } | null = null;
        if (sdkVisible && requested.length <= 80 && requested.join(";").length <= 11_000) {
          try {
            const sdk = await captureSdkRefLayers(adbPath, serial, packageName, root, requested);
            if (timings) Object.assign(timings, { "SDK 补齐": sdk.timing.durationMs, "SDK 补齐调用": sdk.timing.callMs, "SDK 补齐读取": sdk.timing.readMs, "SDK 补齐绘制": sdk.timing.renderMs, "SDK 补齐编码": sdk.timing.encodeMs });
            outcome = { images: sdk.images, failures: sdk.failures, kinds: sdk.kinds, skipDraw: sdk.skipDraw, requested: sdk.timing.requested, skipped: 0, source: "sdk" };
          } catch (error) {
            inspectionContext.getStore()?.signal?.throwIfAborted();
            root.attributes = { ...root.attributes, "sdk-ref-fallback": error instanceof Error ? error.message : "采集失败" };
          }
        }
        if (!outcome) {
          const jdwp = await captureViewBitmaps(Number(port), { windowName, rootRef: root.children[0].attributes!["view-ref"] }, fallback.map((node) => ({ ref: node.attributes!["view-ref"], captureOwn: node.layerImageStatus !== "captured" })), inspectionContext.getStore()?.signal);
          if (timings) Object.assign(timings, { "JDWP 初始化": jdwp.timing.setupMs, "JDWP 定位与识别": jdwp.timing.lookupMs, "JDWP 补图": jdwp.timing.captureMs, "JDWP 生成位图": jdwp.timing.snapshotMs, "JDWP 传输像素": jdwp.timing.pixelsMs, "JDWP 压缩图片": jdwp.timing.compressMs });
          outcome = { images: jdwp.images, failures: jdwp.failures, kinds: jdwp.kinds, skipDraw: jdwp.skipDraw, requested: jdwp.timing.requested, skipped: jdwp.timing.skipped, source: "jdwp" };
        }
        const { images, failures, kinds, skipDraw } = outcome;
        root.attributes = { ...root.attributes, "fallback-source": outcome.source, "jdwp-fallback-candidates": String(fallback.length), "jdwp-fallback-requested": String(outcome.requested), "jdwp-fallback-skipped": String(outcome.skipped) };
        if (failures.size) root.attributes = { ...root.attributes, "texture-capture-warning": `${failures.size} 个控件未完成独立画面补采，原因可在属性栏查看；已保留其余采集结果。` };
        for (const node of fallback) {
          const ref = node.attributes!["view-ref"];
          if (skipDraw.has(ref)) { node.attributes!["skip-draw"] = "true"; node.layerImageStatus = "unavailable"; }
          const kind = kinds.get(ref);
          // A DDMS placeholder is not the Surface/Texture buffer, even when it
          // happens to contain opaque pixels. Never report it as captured video.
          if (outcome.source === "jdwp" && (kind === "surface" || kind === "texture")) {
            if (node.layerImageStatus === "captured") count--;
            delete node.layerImageDataUrl; delete node.layerImageSize; delete node.layerImageEmpty;
            node.layerImageStatus = "failed";
            node.attributes!["image-source"] = kind === "surface" ? "SurfaceView / OpenGL 独立缓冲层" : "TextureView 自身缓冲区";
          }
          const failure = failures.get(ref);
          if (failure) { node.attributes!["image-capture-error"] = failure; if (!node.layerImageDataUrl) node.layerImageStatus = "failed"; }
          const image = images.get(ref);
          if (!image) continue;
          if (image.width !== node.bounds!.right - node.bounds!.left || image.height !== node.bounds!.bottom - node.bounds!.top) {
            node.attributes!["image-capture-error"] = "采集期间控件尺寸变化，请重新采集";
            if (!node.layerImageDataUrl) node.layerImageStatus = "failed";
            continue;
          }
          if (node.layerImageStatus !== "captured") count++;
          node.layerImageDataUrl = image.imageDataUrl;
          node.layerImageSize = { width: image.width, height: image.height };
          node.layerImageStatus = "captured";
          node.layerImageEmpty = image.empty;
          node.attributes!["image-source"] = image.kind === "surface" ? "SurfaceView / OpenGL 独立缓冲层，不含父层或邻居" : image.kind === "texture" ? "TextureView 自身缓冲区" : "按对象身份独立采集，不含子节点";
        }
      } catch {
        inspectionContext.getStore()?.signal?.throwIfAborted();
        root.attributes = { ...root.attributes, "texture-capture-warning": "部分控件的独立画面补采失败，已保留此前采集结果。" };
      }
    }
    return { imageCount: count, finalScreen };
  } finally {
    await inspectionContext.exit(() => runDeviceAdb(adbPath, serial, ["forward", "--remove", `tcp:${port}`])).catch(() => undefined);
  }
}

export function applyViewProperties(root: UiNode, dump: string, restoreHierarchy = false) {
  const properties = new Map<string, Record<string, string>>();
  const records: Array<{ ref: string; indent: number }> = [];
  for (const line of dump.split("\n")) {
    const header = line.match(/^(\s*)(\S+@\w+) /);
    if (!header) {
      if (restoreHierarchy && line.trim() && line.trim() !== "DONE.") throw new Error("Debug 控件树记录格式无效。");
      continue;
    }
    const values: Record<string, string> = {};
    let offset = header[0].length;
    while (offset < line.length) {
      const field = line.slice(offset).match(/^([^= ]+)=(\d+),/);
      if (!field) throw new Error("Debug 控件属性格式不完整。");
      offset += field[0].length;
      const length = Number(field[2]);
      if (!Number.isSafeInteger(length) || offset + length > line.length) throw new Error("Debug 控件属性长度无效。");
      if (offset + length < line.length && line[offset + length] !== " ") throw new Error("Debug 控件属性分隔符无效。");
      values[field[1]] = line.slice(offset, offset + length);
      offset += length + 1;
    }
    if (properties.has(header[2])) throw new Error("Debug 控件对象身份重复，请重新采集。");
    properties.set(header[2], values);
    records.push({ ref: header[2], indent: header[1].length });
  }
  const windowRef = dump.trimStart().split(/\s/)[0];
  for (const node of root.children) {
    const ref = node.attributes?.["view-ref"];
    if (ref && matchesViewRoot(ref, windowRef)) {
      node.className = windowRef.split("@")[0];
      node.attributes = { ...node.attributes, "view-ref": windowRef };
    }
  }
  if (restoreHierarchy) {
    if (!records.length || records.length > 50_000 || records[0].indent !== 0
      || !root.children.some((node) => matchesViewRoot(node.attributes?.["view-ref"] ?? "", records[0].ref))) {
      throw new Error("Debug 控件树不完整或根窗口已变化，请重新采集。");
    }
    const previous = new Map<string, UiNode>();
    const pending = [...root.children];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.attributes?.["view-ref"]) previous.set(node.attributes["view-ref"], node);
      pending.push(...node.children);
    }
    const rebuilt = { ...root, children: [] as UiNode[] };
    const parents = [{ node: rebuilt, indent: -1 }];
    for (const record of records) {
      while (parents.length > 1 && parents.at(-1)!.indent >= record.indent) parents.pop();
      if (parents.length > MAX_UI_HIERARCHY_DEPTH || (parents.length === 1 && rebuilt.children.length)) throw new Error("Debug 控件树结构无效。");
      const parent = parents.at(-1)!.node;
      const old = previous.get(record.ref);
      const index = parent.children.length;
      const node: UiNode = {
        id: `${parent.id}/${index}`, index, package: root.package, className: record.ref.split("@")[0],
        text: old?.text ?? null, resourceId: old?.resourceId ?? null, contentDesc: old?.contentDesc ?? null,
        bounds: null, clickable: false, enabled: true, focusable: false, focused: false,
        scrollable: /Scroll|Recycler/.test(record.ref), selected: false, visibleToUser: true,
        attributes: { "inspection-source": "debug-view", "view-ref": record.ref }, children: [],
      };
      parent.children.push(node);
      parents.push({ node, indent: record.indent });
    }
    root.children = rebuilt.children;
  }
  const stack = [{ node: root, alpha: 1, visible: true }];
  while (stack.length) {
    const { node, alpha, visible } = stack.pop()!;
    const values = properties.get(node.attributes?.["view-ref"] ?? "");
    const ownAlpha = Number(values?.["drawing:getAlpha()"] ?? 1);
    const effectiveAlpha = alpha * (Number.isFinite(ownAlpha) ? Math.max(0, Math.min(1, ownAlpha)) : 1);
    node.attributes = { ...node.attributes, "effective-alpha": String(effectiveAlpha) };
    node.visibleToUser = visible && (values?.["getVisibility()"] !== undefined ? ["VISIBLE", "0"].includes(values["getVisibility()"]) : node.visibleToUser) && effectiveAlpha > 0;
    if (values) {
      if (values["geometry-error"]) node.attributes["geometry-error"] = values["geometry-error"];
      node.attributes["alpha"] = String(ownAlpha);
      const layerName = values["mID"];
      if (layerName && layerName !== "NO_ID") {
        node.attributes["debug-layer-name"] = layerName;
        // DDMS does not include the resource namespace; do not invent one.
        if (!node.resourceId && layerName.startsWith("id/")) node.resourceId = layerName;
      }
      const privateFlags = values["mPrivateFlags"];
      if (privateFlags && /^0x[\da-f]+$/i.test(privateFlags)) node.attributes["skip-draw"] = String((Number(privateFlags) & 0x80) !== 0);
      for (const [property, key] of [["clickable", "isClickable()"], ["enabled", "isEnabled()"], ["focusable", "focus:isFocusable()"], ["focused", "focus:isFocused()"], ["selected", "isSelected()"]] as const) {
        if (values[key] === "true" || values[key] === "false") node[property] = values[key] === "true";
      }
      const text = values["text:mText"] ?? values["text:getText()"];
      if (text !== undefined) node.text = text === "null" ? null : text;
      const description = values["accessibility:getContentDescription()"];
      if (description !== undefined) node.contentDesc = description === "null" ? null : description;
      const exported = {
        z: ["drawing:getZ()"],
        elevation: ["drawing:getElevation()"],
        "translation-z": ["drawing:getTranslationZ()"],
        "clip-children": ["drawing:getClipChildren()"],
        "clip-to-padding": ["drawing:getClipToPadding()"],
        "padding-left": ["padding:mPaddingLeft", "padding:getPaddingLeft()"],
        "padding-top": ["padding:mPaddingTop", "padding:getPaddingTop()"],
        "padding-right": ["padding:mPaddingRight", "padding:getPaddingRight()"],
        "padding-bottom": ["padding:mPaddingBottom", "padding:getPaddingBottom()"],
        rotation: ["drawing:getRotation()"],
        "scale-x": ["drawing:getScaleX()"],
        "scale-y": ["drawing:getScaleY()"],
      };
      for (const [key, aliases] of Object.entries(exported)) {
        const value = aliases.map((alias) => values[alias]).find((value) => value !== undefined);
        if (value !== undefined && (value === "true" || value === "false" || (value.trim() !== "" && Number.isFinite(Number(value))))) node.attributes[key] = value;
      }
      const x = Number(values["layout:getLocationOnScreen_x()"]);
      const y = Number(values["layout:getLocationOnScreen_y()"]);
      const width = Number(values["layout:getWidth()"]);
      const height = Number(values["layout:getHeight()"]);
      if ([x, y, width, height].every(Number.isFinite)) node.bounds = { left: x, top: y, right: x + width, bottom: y + height, raw: `[${x},${y}][${x + width},${y + height}]` };
    }
    for (const child of node.children) stack.push({ node: child, alpha: effectiveAlpha, visible: node.visibleToUser });
  }
}

export function qmlUiTree(root: QmlDebugNode, packageName: string, viewport: UiBounds | null, images: ReadonlyMap<number, { dataUrl: string; width: number; height: number }> = new Map()): UiNode {
  const rootGeometry = root.geometry;
  const scaleX = viewport && rootGeometry?.width ? (viewport.right - viewport.left) / rootGeometry.width : 1;
  const scaleY = viewport && rootGeometry?.height ? (viewport.bottom - viewport.top) / rootGeometry.height : scaleX;
  const offsetX = viewport?.left ?? 0;
  const offsetY = viewport?.top ?? 0;
  const clickableType = /(Button|MouseArea|TapHandler|CheckBox|Switch|Slider|TextField|ComboBox)/i;

  const convert = (source: QmlDebugNode, id: string, index: number): UiNode => {
    const geometry = source.geometry;
    const bounds = geometry ? {
      left: Math.round(offsetX + geometry.x * scaleX),
      top: Math.round(offsetY + geometry.y * scaleY),
      right: Math.round(offsetX + (geometry.x + geometry.width) * scaleX),
      bottom: Math.round(offsetY + (geometry.y + geometry.height) * scaleY),
      raw: "",
    } : null;
    if (bounds) bounds.raw = `[${bounds.left},${bounds.top}][${bounds.right},${bounds.bottom}]`;
    const node: UiNode = {
      id,
      index,
      className: source.type || "QmlObject",
      package: packageName,
      text: geometry?.text || null,
      resourceId: source.idString || source.objectName || null,
      contentDesc: null,
      bounds,
      clickable: clickableType.test(source.type),
      enabled: geometry?.enabled ?? true,
      focusable: /(Focus|Input|TextField|Button)/i.test(source.type),
      focused: false,
      scrollable: /(Flickable|ListView|GridView|ScrollView)/i.test(source.type),
      selected: false,
      // QObject/attached-property wrappers have no geometry, but may own visual
      // descendants. Zero-size Items can also have unclipped visible children.
      visibleToUser: !geometry || (geometry.visible && geometry.effectiveOpacity > 0),
      attributes: {
        "inspection-source": "debug-qml",
        "qml-debug-id": String(source.debugId),
        "qml-context-id": String(source.contextId),
        "qml-parent-id": String(source.parentId),
        "qml-source": source.url,
        "qml-line": String(source.line),
        opacity: String(geometry?.opacity ?? 1),
        alpha: String(geometry?.opacity ?? 1),
        "effective-alpha": String(geometry?.effectiveOpacity ?? 1),
        "qml-clip": String(geometry?.clip ?? false),
        "qml-layer-enabled": String(geometry?.layerEnabled ?? false),
        z: String(geometry?.z ?? 0),
        "drawing-order": String(geometry?.z ?? index),
      },
      children: [],
    };
    if (geometry?.style && bounds && geometry.width > 0 && geometry.height > 0 && bounds.right > bounds.left && bounds.bottom > bounds.top) {
      const style = geometry.style;
      const imageSize = textureDimensions(bounds.right - bounds.left, bounds.bottom - bounds.top);
      const svg = qmlStyleSvg(style, geometry, imageSize, scaleX);
      node.layerImageDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
      node.layerImageSize = imageSize;
      node.layerImageStatus = "style";
      Object.assign(node.attributes!, {
        "background-color": style.fill ? qmlColorCss(style.fill) : "未暴露",
        "border-color": style.border ? qmlColorCss(style.border) : "未暴露",
        "border-width": String(style.borderWidth * scaleX),
        "border-status": style.borderValidityUnknown ? "默认黑色 1px 边框的启用状态未暴露，未绘制" : "已读取",
        "corner-radii": style.radii.map((r) => r * scaleX).join(" / "),
        "background-gradient": style.unsupportedGradient ? "不支持的渐变预设，未绘制填充" : style.gradient ? JSON.stringify(style.gradient) : "none",
      });
    }
    const image = images.get(source.debugId);
    if (image && bounds) {
      node.layerImageDataUrl = image.dataUrl;
      node.layerImageSize = { width: image.width, height: image.height };
      node.layerImageStatus = "captured";
    }
    node.children = source.children.map((child, childIndex) => convert(child, `${id}/${childIndex}`, childIndex));
    return node;
  };
  return convert(root, "0", 0);
}

function delay(milliseconds: number) {
  return wait(milliseconds, undefined, { signal: inspectionContext.getStore()?.signal });
}

async function readQmlGrabs(adbPath: string, serial: string, packageName: string, appDir: string, grabs: QmlGrab[]) {
  const images = new Map<number, { dataUrl: string; width: number; height: number }>();
  if (!grabs.length) return images;
  const prefix = `${appDir}/`;
  try {
    await delay(300);
    for (let start = 0; start < grabs.length; start += 4) {
      await Promise.all(grabs.slice(start, start + 4).map(async (grab) => {
        if (!grab.path.startsWith(prefix)) return;
        const file = grab.path.slice(prefix.length);
        for (let attempt = 0; attempt < 4; attempt++) {
          let result: CommandResult;
          try { result = await runDeviceAdb(adbPath, serial, ["exec-out", "run-as", packageName, "head", "-c", "3000001", file]); }
          catch { inspectionContext.getStore()?.signal?.throwIfAborted(); return; }
          const size = result.code === 0 && result.stdout.length <= 3_000_000 ? pngSize(result.stdout) : null;
          if (size && size.width * size.height <= 2_000_000
            && Math.abs(size.width / size.height - grab.width / grab.height) <= grab.width / grab.height * 0.05) {
            images.set(grab.debugId, { dataUrl: `data:image/png;base64,${result.stdout.toString("base64")}`, ...size });
            return;
          }
          await delay(250);
        }
      }));
    }
  } finally {
    await inspectionContext.exit(() => runDeviceAdb(adbPath, serial, ["shell", "run-as", packageName, "rm", "-f", ...grabs.map((grab) => grab.path.slice(prefix.length))])).catch(() => undefined);
  }
  return images;
}

async function qmlDebugTree(adbPath: string, serial: string, target: ForegroundTarget, groupDebugId?: number) {
  const signal = inspectionContext.getStore()?.signal;
  signal?.throwIfAborted();
  const forward = await inspectionContext.exit(() => runDeviceAdb(adbPath, serial, ["forward", "tcp:0", `tcp:${QML_DEBUG_PORT}`]));
  if (forward.code !== 0) throw new Error(commandError("无法转发 QML 调试端口", forward));
  const port = Number(forward.stdout.toString("utf8").trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("QML 调试转发端口无效。");

  try {
    signal?.throwIfAborted();
    let directory: CommandResult | null = null;
    try { directory = await runDeviceAdb(adbPath, serial, ["shell", "run-as", target.packageName, "pwd"]); }
    catch { signal?.throwIfAborted(); }
    const appDir = directory?.stdout.toString("utf8").trim() ?? "";
    const canGrab = directory?.code === 0 && /^\/data\/(?:user(?:_de)?\/\d+|data)\/[\w.]+$/.test(appDir) && appDir.endsWith(`/${target.packageName}`);
    const capture = async () => {
      const processId = await singleAppPid(adbPath, serial, target.packageName);
      const inspected = await inspectQmlHierarchy(port, signal, canGrab ? { appDir, nonce: randomUUID(), groupDebugId } : undefined);
      let images = new Map<number, { dataUrl: string; width: number; height: number }>();
      let captureWarning = !canGrab ? "无法定位 Qt App 私有缓存目录，已保留控件树。" : inspected.grabFailed ? "部分 Qt 控件截图请求失败，已保留控件树。" : null;
      try { images = await readQmlGrabs(adbPath, serial, target.packageName, appDir, inspected.grabs); }
      catch { signal?.throwIfAborted(); captureWarning = "Qt 控件截图读取失败，已保留控件树。"; }
      if (inspected.grabs.length && images.size < inspected.grabs.length) captureWarning ??= `仅取得 ${images.size}/${inspected.grabs.length} 张 Qt 独立画面。`;
      if (processId !== await singleAppPid(adbPath, serial, target.packageName)) throw new Error("Qt App 进程已变化，请重新采集。");
      return { root: inspected.root, images, captureWarning, processId };
    };
    if (inspectionContext.getStore()?.allowAppRestart === false) {
      // Automated observation must never reset the page it is trying to verify.
      return { ...await capture(), restarted: false };
    }
    try {
      const captured = await capture();
      return { ...captured, restarted: false };
    } catch {
      signal?.throwIfAborted();
    }

    await runDeviceAdb(adbPath, serial, ["shell", "am", "force-stop", target.packageName]);
    const start = await runDeviceAdb(adbPath, serial, [
      "shell", "am", "start", "-n", target.component,
      "--es", "applicationArguments", `-qmljsdebugger=port:${QML_DEBUG_PORT},services:QmlDebugger`,
    ]);
    if (start.code !== 0 || /\bError:/.test(start.stdout.toString("utf8"))) {
      throw new Error(commandError("无法以 QML Debug 模式启动目标 App", start));
    }

    let lastError: unknown = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const captured = await capture();
        return { ...captured, restarted: true };
      } catch (error) {
        signal?.throwIfAborted();
        lastError = error;
        await delay(250);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("无法连接 QML Debug 服务。");
  } finally {
    await inspectionContext.exit(() => runDeviceAdb(adbPath, serial, ["forward", "--remove", `tcp:${port}`])).catch(() => undefined);
  }
}

function nodeById(root: UiNode, id: string): UiNode | null {
  const pending = [root];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const node = pending[cursor];
    if (node.id === id) return node;
    pending.push(...node.children);
  }
  return null;
}

export function qmlGroupNodeMatches(expected: UiNode, current: UiNode): boolean {
  const a = expected.bounds, b = current.bounds;
  return expected.id === current.id && expected.className === current.className
    && expected.package === current.package && expected.resourceId === current.resourceId
    && expected.children.length > 0 && current.children.length > 0
    && expected.visibleToUser && current.visibleToUser && Boolean(a && b)
    && a!.left === b!.left && a!.top === b!.top && a!.right === b!.right && a!.bottom === b!.bottom
    && ["qml-debug-id", "qml-context-id", "qml-parent-id", "qml-source", "qml-line"].every(key => expected.attributes?.[key] === current.attributes?.[key]);
}

export function nativeViewNodeMatches(expectedRoot: UiNode, currentRoot: UiNode, nodeId: string): boolean {
  let expected = expectedRoot, current = currentRoot;
  if (nodeId === expectedRoot.id) return false;
  for (const part of nodeId.split("/").slice(1)) {
    if (!/^\d+$/.test(part)) return false;
    const index = Number(part);
    expected = expected.children[index]; current = current.children[index];
    if (!expected || !current || !expected.attributes?.["view-ref"]
      || expected.attributes["view-ref"] !== current.attributes?.["view-ref"]
      || expected.className !== current.className) return false;
  }
  return Boolean(expected.bounds && current.bounds && expected.visibleToUser && current.visibleToUser
    && expected.children.length === current.children.length
    && expected.children.every((child, index) => child.attributes?.["view-ref"] === current.children[index].attributes?.["view-ref"]));
}

export function nativeViewBranchMatches(expectedRoot: UiNode, currentRoot: UiNode, nodeId: string): boolean {
  if (!nativeViewNodeMatches(expectedRoot, currentRoot, nodeId)) return false;
  const expected = nodeById(expectedRoot, nodeId), current = nodeById(currentRoot, nodeId);
  if (!expected || !current) return false;
  const pending: [UiNode, UiNode][] = [[expected, current]];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const [a, b] = pending[cursor];
    if (a.id !== b.id || a.className !== b.className || a.attributes?.["view-ref"] !== b.attributes?.["view-ref"] || a.children.length !== b.children.length) return false;
    a.children.forEach((child, index) => pending.push([child, b.children[index]]));
  }
  return true;
}

// 分支刷新身份校验失败时定位第一个差异点（仅诊断日志使用，不参与判定）。
function describeBranchContextMismatch(expectedRoot: UiNode, currentRoot: UiNode, branchId: string): string {
  const expected = nodeById(expectedRoot, branchId), current = nodeById(currentRoot, branchId);
  if (!expected || !current) return `分支节点在${!expected ? "快照" : "活树"}中缺失`;
  const pending: [UiNode, UiNode][] = [[expectedRoot, currentRoot]];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const [old, latest] = pending[cursor];
    if (old.id !== latest.id || old.className !== latest.className || old.attributes?.["view-ref"] !== latest.attributes?.["view-ref"])
      return `节点不一致：${old.id} ${old.className} → ${latest.id} ${latest.className}`;
    if (branchId.startsWith(`${old.id}/`) && old.bounds?.raw !== latest.bounds?.raw)
      return `祖先边界变化：${old.id} ${old.className} ${old.bounds?.raw} → ${latest.bounds?.raw}`;
    if (old.id !== branchId && old.visibleToUser !== latest.visibleToUser)
      return `祖先可见性变化：${old.id} ${old.className} ${old.visibleToUser} → ${latest.visibleToUser}`;
    if (old.id === branchId) return "分支节点通过（不应到达）";
    if (old.children.length !== latest.children.length)
      return `子节点数变化：${old.id} ${old.className} ${old.children.length} → ${latest.children.length}（新增/删除了分支外兄弟）`;
    old.children.forEach((child, index) => pending.push([child, latest.children[index]]));
  }
  return "结构一致（不应到达）";
}

export function nativeViewBranchContextMatches(expectedRoot: UiNode, currentRoot: UiNode, branchId: string): boolean {
  if (!nodeById(expectedRoot, branchId) || !nodeById(currentRoot, branchId)) return false;
  const pending: [UiNode, UiNode][] = [[expectedRoot, currentRoot]];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const [old, latest] = pending[cursor];
    if (old.id !== latest.id || old.className !== latest.className || old.attributes?.["view-ref"] !== latest.attributes?.["view-ref"]
        || branchId.startsWith(`${old.id}/`) && old.bounds?.raw !== latest.bounds?.raw
        || old.id !== branchId && old.visibleToUser !== latest.visibleToUser
        || old.id !== expectedRoot.id && !old.attributes?.["view-ref"]) return false;
    if (old.id === branchId) continue;
    if (old.children.length !== latest.children.length) return false;
    old.children.forEach((child, index) => pending.push([child, latest.children[index]]));
  }
  return true;
}

// 分支刷新读树时可能出现的瞬时失败（JDWP 属性流编码竞态、dumpsys 段落缺层级、空回包）：
// 重读一次通常可恢复；身份/层级变化类错误不在此列，绝不重试。
export function isTransientTreeReadError(message: string): boolean {
  return /Debug V2|返回内容为空|返回了无效数据|无法从 Debug App 读取 View Hierarchy|Debug View 连接超时|未读取到 Debug View 节点/.test(message);
}

// 单次控件刷新（分支或列表）的可见控件上限。
const MAX_VIEW_REFRESH_NODES = 64;

// 分支/列表刷新共用的活树读取器：dumpsys 段落 + JDWP 属性 + merged 快照 SDK 同源 adopt，
// 瞬态读树失败有界重试，身份/层级变化立即拒绝。返回 { 整树, 目标节点 }。
function buildReadCurrent(args: {
  adbPath: string; serial: string; packageName: string; snapshot: UiSnapshot; root: UiNode;
  section: string; before: ForegroundTarget; port: string; rootRef: string; windowName: string;
  processId: number; branch: boolean; nodeId: string; signal?: AbortSignal;
}): () => Promise<{ root: UiNode; node: UiNode }> {
  const { adbPath, serial, packageName, snapshot, root, section, before, port, rootRef, windowName, processId, branch, nodeId, signal } = args;
  return async () => {
    let currentSection = section;
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      if (attempt > 0) await new Promise<void>(resolve => setTimeout(resolve, attempt === 1 ? 600 : 1200)); // 编码竞态与 UI 变更相关：慢态设备间隔更长
      try {
        const dumped = debugViewTree(currentSection, before);
        let name = "";
        await captureViewLayers(Number(port), {
          rootRefs: [rootRef], skipImages: true, signal,
          onHierarchy: (dump, window) => { applyViewProperties(dumped, dump, true); name = window; },
        });
        if (name !== windowName) throw new Error("控件身份、位置或层级已变化，请重新采集整页。");
        let current = dumped;
        // D2/D3 合并快照的结构来自 SDK 树（adoptSdkTree 重建，容忍 dumpsys 丢弃无坐标包装层）；
        // dumpsys 活树缺这些层时路径错位、身份校验必然拒绝。merged 快照的读树先做同源 adopt 再对比。
        if (snapshot.inspectionSource === "debug-hybrid" && root.attributes?.["sdk-tree-source"] === "merged") {
          const sdk = await readSdkCapture(adbPath, serial, packageName);
          adoptSdkTree(current, sdk, packageName, processId);
          current.attributes = { ...current.attributes, "sdk-tree-source": "merged" };
          console.log("[branch-refresh] 活树已按 SDK 结构同源重建（快照为 merged 采集）。");
        }
        if (!(branch ? nativeViewBranchContextMatches(root, current, nodeId) : nativeViewNodeMatches(root, current, nodeId))) {
          console.log(`[branch-refresh] 身份校验失败：${branch ? describeBranchContextMismatch(root, current, nodeId) : `单节点 ${nodeId}`}（快照来源=${snapshot.inspectionSource} 结构=${root.attributes?.["sdk-tree-source"] ?? "dump"}）`);
          throw new Error("控件身份、位置或层级已变化，请重新采集整页。");
        }
        return { root: current, node: nodeById(current, nodeId)! };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (attempt >= 2 || !isTransientTreeReadError(message)) throw error;
        // 瞬时读树失败：重取一次 dumpsys 段落后重读；身份变化类错误不重试。
        const retry = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", packageName]);
        if (retry.code === 0) {
          try { currentSection = targetActivitySection(retry.stdout.toString("utf8"), before); } catch { /* 保留原段落 */ }
        }
      }
    }
  };
}

// 可见项分批：以条目为最小单位，把各条目的可见控件数按顺序装箱，每批总数 ≤ cap；
// 单条超过 cap 的条目进 oversized（由调用方按 partial-failure 语义跳过并记录，不阻断整批）。
export function partitionViewItems(sizes: number[], cap: number): { batches: number[][]; oversized: number[] } {
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("分批上限无效。");
  const batches: number[][] = [], oversized: number[] = [];
  let current: number[] = [], used = 0;
  for (let index = 0; index < sizes.length; index++) {
    const size = sizes[index] ?? 0;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("条目可见控件数无效。");
    if (size > cap) {
      if (current.length) { batches.push(current); current = []; used = 0; }
      oversized.push(index);
      continue;
    }
    if (used + size > cap && current.length) { batches.push(current); current = []; used = 0; }
    current.push(index);
    used += size;
  }
  if (current.length) batches.push(current);
  return { batches, oversized };
}

export function captureViewNodes(serial: string, snapshot: UiSnapshot, nodeId: string, branch = false, signal?: AbortSignal): Promise<ViewRefreshResult> {
  return inspectionContext.run({ signal, allowAppRestart: false }, async () => {
    const root = snapshot.root, packageName = root?.package;
    const target = root && nodeById(root, nodeId);
    const rootRef = root?.children[0]?.attributes?.["view-ref"];
    const processId = Number(root?.attributes?.["debug-process-id"]);
    const windowName = root?.attributes?.["debug-window-name"];
    const component = root?.attributes?.["debug-component"];
    if ((snapshot.inspectionSource !== "debug-view" && snapshot.inspectionSource !== "debug-hybrid") || snapshot.serial !== serial || !root || !packageName || !target?.bounds
      || !target.attributes?.["view-ref"] || !rootRef || !windowName || !component || !Number.isSafeInteger(processId) || processId < 1)
      throw new Error("这份快照不支持控件刷新，请重新采集当前页面。");
    const adbPath = automationAdb(serial);
    const sameProcess = async () => {
      const result = await runDeviceAdb(adbPath, serial, ["shell", "pidof", packageName]);
      return result.code === 0 && result.stdout.toString("utf8").trim().split(/\s+/).includes(String(processId));
    };
    const before = await checkedDebugTarget(adbPath, serial, packageName);
    if (before.component !== component || !await sameProcess())
      throw new Error("目标 App 或进程已变化，请重新采集整页。");
    const activity = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", packageName]);
    if (activity.code !== 0) throw new Error("无法核对当前控件树，请重新采集整页。");
    const section = targetActivitySection(activity.stdout.toString("utf8"), before);
    const forwarded = await inspectionContext.exit(() => runDeviceAdb(adbPath, serial, ["forward", "tcp:0", `jdwp:${processId}`]));
    const port = forwarded.stdout.toString("utf8").trim();
    if (forwarded.code !== 0 || !/^\d+$/.test(port)) throw new Error("无法连接当前 Debug App。");
    try {
      const readCurrent = buildReadCurrent({ adbPath, serial, packageName, snapshot, root, section, before, port, rootRef, windowName, processId, branch, nodeId, signal });
      const first = await readCurrent();
      const beforeCapture = first.node;
      const candidates = branch ? [beforeCapture] : [target];
      if (branch) for (let cursor = 0; cursor < candidates.length; cursor++) {
        candidates.push(...candidates[cursor].children);
      }
      const requested = candidates.filter(node => node.visibleToUser && node.attributes?.["view-ref"] && node.bounds
        && node.bounds.right > node.bounds.left && node.bounds.bottom > node.bounds.top);
      if (requested.length > MAX_VIEW_REFRESH_NODES) throw new Error(`此分支有 ${requested.length} 个可见控件，超过单次 ${MAX_VIEW_REFRESH_NODES} 个上限；请选择较小分支或改用可见项分批刷新。`);
      if (!requested.length) {
        console.log(`[branch-refresh] 分支无可刷新可见控件：id=${nodeId} cls=${beforeCapture.className ?? "-"} ref=${beforeCapture.attributes?.["view-ref"] ?? "-"} visible=${beforeCapture.visibleToUser} bounds=${beforeCapture.bounds?.raw ?? "-"} 分支子树=${candidates.length}（活树路径已通过身份校验）`);
        throw new Error("此分支没有可刷新的可见控件。");
      }
      const { images, failures, kinds, skipDraw } = await captureViewBitmaps(Number(port), { rootRef, windowName }, requested.map(node => ({ ref: node.attributes!["view-ref"], captureOwn: true })), signal);
      const second = await readCurrent();
      const current = second.node;
      const after = await checkedDebugTarget(adbPath, serial, packageName);
      if (after.component !== before.component || after.windowId !== before.windowId || !await sameProcess())
        throw new Error("目标 App、进程或窗口已变化，请重新采集整页。");
      if (branch && !nativeViewBranchMatches(first.root, second.root, nodeId))
        throw new Error("分支在刷新期间变化，请重试。");
      if (branch) {
        for (const node of requested) if (node.bounds?.raw !== nodeById(second.root, node.id)?.bounds?.raw)
          throw new Error("分支在补图期间移动，请重试。");
        let latestRoot = second.root;
        if (snapshot.inspectionSource === "debug-hybrid") {
          const sdk = await readSdkCapture(adbPath, serial, packageName);
          const merged = joinSdkTreeAndDebugImages({ ...snapshot, inspectionSource: "debug-view", root: second.root,
            nodeCount: countNodes(second.root) }, sdk, packageName, processId);
          if (merged.root?.attributes?.["sdk-process-instance"] !== root.attributes?.["sdk-process-instance"])
            throw new Error("SDK 进程实例已变化，请重新采集整页。");
          latestRoot = merged.root!;
          const confirmed = await checkedDebugTarget(adbPath, serial, packageName);
          if (confirmed.component !== before.component || confirmed.windowId !== before.windowId || !await sameProcess())
            throw new Error("SDK 补验时窗口已变化，请重新采集整页。");
        }
        const oldByRef = new Map<string, UiNode>();
        const oldPending = [target];
        for (let cursor = 0; cursor < oldPending.length; cursor++) {
          const old = oldPending[cursor], ref = old.attributes?.["view-ref"];
          if (!ref || oldByRef.has(ref)) throw new Error("原分支控件身份重复，请重新采集整页。");
          oldByRef.set(ref, old);
          oldPending.push(...old.children);
        }
        const latestBranch = nodeById(latestRoot, nodeId)!;
        const requestedRefs = new Set(requested.map(node => node.attributes!["view-ref"]));
        const allRefs = new Set<string>();
        const wholeTree = [latestRoot];
        for (let cursor = 0; cursor < wholeTree.length; cursor++) {
          const node = wholeTree[cursor], ref = node.attributes?.["view-ref"];
          if (ref && allRefs.has(ref)) throw new Error("刷新后的控件树包含重复对象身份。");
          if (ref) allRefs.add(ref);
          wholeTree.push(...node.children);
        }
        const seen = new Set<string>();
        const nodeFailures: ViewRefreshResult["failures"] = [];
        const refreshedAt = new Date().toISOString();
        let refreshed = 0;
        const pending = [latestBranch];
        for (let cursor = 0; cursor < pending.length; cursor++) {
          const node = pending[cursor], ref = node.attributes?.["view-ref"];
          if (!ref || seen.has(ref)) throw new Error("刷新后的分支控件身份重复。");
          seen.add(ref);
          pending.push(...node.children);
          if (!requestedRefs.has(ref)) { node.layerImageStatus = node.visibleToUser ? "unavailable" : "hidden"; continue; }
          const old = oldByRef.get(ref), image = images.get(ref), kind = kinds.get(ref);
          const sizeMatches = image && node.bounds && image.width === node.bounds.right - node.bounds.left && image.height === node.bounds.bottom - node.bounds.top;
          const attributes = node.attributes = { ...node.attributes };
          delete attributes["image-capture-error"];
          delete attributes["image-refresh-error"];
          if (image && sizeMatches) {
            node.layerImageStatus = "captured";
            node.layerImageDataUrl = image.imageDataUrl;
            node.layerImageSize = { width: image.width, height: image.height };
            node.layerImageEmpty = image.empty;
            attributes["image-source"] = kind === "surface" ? "SurfaceView / OpenGL 独立缓冲层" : kind === "texture" ? "TextureView 自身缓冲区" : "按对象身份独立采集，不含子节点";
            attributes["image-refreshed-at"] = refreshedAt;
            refreshed++;
          } else if (!image && skipDraw.has(ref)) {
            node.layerImageStatus = "unavailable";
            attributes["skip-draw"] = "true";
            attributes["image-source"] = "结构容器，系统跳过自身绘制";
            attributes["image-refreshed-at"] = refreshedAt;
            refreshed++;
          } else {
            const reason = image ? "控件画面尺寸已变化，请重试。" : failures.get(ref) ?? "未取得控件独立画面。";
            nodeFailures.push({ id: node.id, message: reason });
            if (old?.layerImageStatus === "captured" && old.layerImageDataUrl && old.bounds?.raw === node.bounds?.raw && old.className === node.className) {
              node.layerImageStatus = old.layerImageStatus;
              node.layerImageDataUrl = old.layerImageDataUrl;
              node.layerImageSize = old.layerImageSize;
              node.layerImageEmpty = old.layerImageEmpty;
              attributes["image-source"] = old.attributes?.["image-source"] ?? "原快照独立画面";
              if (old.attributes?.["image-refreshed-at"]) attributes["image-refreshed-at"] = old.attributes["image-refreshed-at"];
              attributes["image-refresh-error"] = `${reason} 已保留旧画面。`;
            } else {
              node.layerImageStatus = "failed";
              attributes["image-capture-error"] = reason;
              delete attributes["image-source"];
            }
          }
        }
        if (!refreshed) throw new Error(`分支补图全部失败：${nodeFailures[0]?.message ?? "未取得独立画面"}；原快照已保留。`);
        signal?.throwIfAborted();
        return { nodes: [], failures: nodeFailures, branch: latestBranch };
      }
      const beforeNodes = new Map<string, UiNode>(), currentNodes = new Map<string, UiNode>();
      for (const node of [beforeCapture, current]) {
        const map = node === beforeCapture ? beforeNodes : currentNodes;
        const pending = [node];
        for (let cursor = 0; cursor < pending.length; cursor++) { map.set(pending[cursor].id, pending[cursor]); pending.push(...pending[cursor].children); }
      }
      const nodes: UiNode[] = [], nodeFailures: ViewRefreshResult["failures"] = [];
      const refreshedAt = new Date().toISOString();
      for (const original of requested) {
        const ref = original.attributes!["view-ref"], latest = currentNodes.get(original.id)!;
        const image = images.get(ref);
        const reason = beforeNodes.get(original.id)?.bounds?.raw !== latest.bounds?.raw ? "控件在刷新期间移动了，请重试。"
          : image && latest.bounds && (image.width !== latest.bounds.right - latest.bounds.left || image.height !== latest.bounds.bottom - latest.bounds.top) ? "控件画面尺寸已变化，请重新采集整页。"
          : !image && !skipDraw.has(ref) ? failures.get(ref) ?? "未取得控件独立画面；原快照已保留。" : null;
        if (reason) { nodeFailures.push({ id: original.id, message: reason }); continue; }
        const kind = kinds.get(ref);
        const attributes: Record<string, string> = { ...original.attributes, ...latest.attributes,
          "image-source": image ? kind === "surface" ? "SurfaceView / OpenGL 独立缓冲层" : kind === "texture" ? "TextureView 自身缓冲区" : "按对象身份独立采集，不含子节点" : "结构容器，系统跳过自身绘制",
          "image-refreshed-at": refreshedAt,
        };
        delete attributes["image-capture-error"];
        delete attributes["image-refresh-error"];
        nodes.push({
          ...original, bounds: latest.bounds, text: latest.text, contentDesc: latest.contentDesc, clickable: latest.clickable,
          enabled: latest.enabled, focusable: latest.focusable, focused: latest.focused,
          selected: latest.selected, scrollable: latest.scrollable, attributes,
          layerImageStatus: image ? "captured" : "unavailable", layerImageDataUrl: image?.imageDataUrl,
          layerImageSize: image ? { width: image.width, height: image.height } : undefined,
          layerImageEmpty: image?.empty, children: [], // The renderer keeps the original subtree.
        });
      }
      if (!nodes.length) throw new Error(nodeFailures.length === 1 ? nodeFailures[0].message : `${nodeFailures.length} 个控件均未刷新；原快照已保留。`);
      signal?.throwIfAborted();
      return { nodes, failures: nodeFailures };
    } finally {
      await inspectionContext.exit(() => runDeviceAdb(adbPath, serial, ["forward", "--remove", `tcp:${port}`])).catch(() => undefined);
    }
  });
}

// 可见项分批刷新（大列表）：刷新目标节点的直接子层——视口内条目按 ≤MAX_VIEW_REFRESH_NODES 的
// 批次补图、按对象身份合并；屏外条目保留旧画面并标注 out-of-viewport；刷新期间列表结构或条目
// 位置变化、条目身份漂移均安全拒绝并提示整页重采；单条超过上限的条目按 partial-failure 跳过。
export function captureListViewItems(serial: string, snapshot: UiSnapshot, nodeId: string, signal?: AbortSignal): Promise<ViewRefreshResult> {
  return inspectionContext.run({ signal, allowAppRestart: false }, async () => {
    const root = snapshot.root, packageName = root?.package;
    const target = root && nodeById(root, nodeId);
    const rootRef = root?.children[0]?.attributes?.["view-ref"];
    const processId = Number(root?.attributes?.["debug-process-id"]);
    const windowName = root?.attributes?.["debug-window-name"];
    const component = root?.attributes?.["debug-component"];
    if ((snapshot.inspectionSource !== "debug-view" && snapshot.inspectionSource !== "debug-hybrid") || snapshot.serial !== serial || !root || !packageName || !target?.bounds
        || !target.attributes?.["view-ref"] || !rootRef || !windowName || !component || !Number.isSafeInteger(processId) || processId < 1)
      throw new Error("这份快照不支持控件刷新，请重新采集当前页面。");
    const adbPath = automationAdb(serial);
    const sameProcess = async () => {
      const result = await runDeviceAdb(adbPath, serial, ["shell", "pidof", packageName]);
      return result.code === 0 && result.stdout.toString("utf8").trim().split(/\s+/).includes(String(processId));
    };
    const before = await checkedDebugTarget(adbPath, serial, packageName);
    if (before.component !== component || !await sameProcess())
      throw new Error("目标 App 或进程已变化，请重新采集整页。");
    const activity = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", packageName]);
    if (activity.code !== 0) throw new Error("无法核对当前控件树，请重新采集整页。");
    const section = targetActivitySection(activity.stdout.toString("utf8"), before);
    const forwarded = await inspectionContext.exit(() => runDeviceAdb(adbPath, serial, ["forward", "tcp:0", `jdwp:${processId}`]));
    const port = forwarded.stdout.toString("utf8").trim();
    if (forwarded.code !== 0 || !/^\d+$/.test(port)) throw new Error("无法连接当前 Debug App。");
    try {
      const readCurrent = buildReadCurrent({ adbPath, serial, packageName, snapshot, root, section, before, port, rootRef, windowName, processId, branch: true, nodeId, signal });
      const first = await readCurrent();
      const liveList = first.node;
      if (!liveList.children.length) throw new Error("此节点没有可刷新的子项。");
      const requestedNode = (node: UiNode) => node.visibleToUser && node.attributes?.["view-ref"] && node.bounds && node.bounds.right > node.bounds.left && node.bounds.bottom > node.bounds.top;
      const itemNodes = (item: UiNode) => {
        const nodes: UiNode[] = [];
        const pending = [item];
        for (let cursor = 0; cursor < pending.length; cursor++) { const node = pending[cursor]; if (requestedNode(node)) nodes.push(node); pending.push(...node.children); }
        return nodes;
      };
      const viewportItems = liveList.children.filter(requestedNode);
      if (!viewportItems.length) throw new Error("此列表当前没有可见条目，请滚动到目标区域后重试。");
      const { batches, oversized } = partitionViewItems(viewportItems.map(item => itemNodes(item).length), MAX_VIEW_REFRESH_NODES);
      const nodeFailures: ViewRefreshResult["failures"] = [];
      for (const index of oversized)
        nodeFailures.push({ id: viewportItems[index].id, message: `条目有 ${itemNodes(viewportItems[index]).length} 个可见控件，超过单次 ${MAX_VIEW_REFRESH_NODES} 个上限，已跳过该条目。` });
      // 每批需要补图的节点（条目子树内全部可见控件；列表容器自身并入首批，与分支刷新语义一致）。
      const batchNodes: UiNode[][] = batches.map(batch => batch.flatMap(index => itemNodes(viewportItems[index])));
      if (batchNodes.length) batchNodes[0] = [liveList, ...batchNodes[0]];
      type ListBitmaps = Awaited<ReturnType<typeof captureViewBitmaps>>;
      const images: ListBitmaps["images"] = new Map();
      const kinds = new Map<string, string>();
      const skipDraw = new Set<string>();
      const captureFailures = new Map<string, string>();
      for (const nodes of batchNodes) {
        const batch = await captureViewBitmaps(Number(port), { rootRef, windowName }, nodes.map(node => ({ ref: node.attributes!["view-ref"], captureOwn: true })), signal);
        for (const [ref, image] of batch.images) images.set(ref, image);
        for (const [ref, kind] of batch.kinds) kinds.set(ref, kind);
        for (const ref of batch.skipDraw) skipDraw.add(ref);
        for (const [ref, message] of batch.failures) if (!images.has(ref)) captureFailures.set(ref, message);
      }
      const allRequested = batchNodes.flat();
      const second = await readCurrent();
      const after = await checkedDebugTarget(adbPath, serial, packageName);
      if (after.component !== before.component || after.windowId !== before.windowId || !await sameProcess())
        throw new Error("目标 App、进程或窗口已变化，请重新采集整页。");
      if (!nativeViewBranchMatches(first.root, second.root, nodeId))
        throw new Error("列表在刷新期间变化，请重试。");
      for (const node of allRequested) if (node.bounds?.raw !== nodeById(second.root, node.id)?.bounds?.raw)
        throw new Error("条目在补图期间移动，请重试。");
      let latestRoot = second.root;
      if (snapshot.inspectionSource === "debug-hybrid") {
        const sdk = await readSdkCapture(adbPath, serial, packageName);
        const merged = joinSdkTreeAndDebugImages({ ...snapshot, inspectionSource: "debug-view", root: second.root,
          nodeCount: countNodes(second.root) }, sdk, packageName, processId);
        if (merged.root?.attributes?.["sdk-process-instance"] !== root.attributes?.["sdk-process-instance"])
          throw new Error("SDK 进程实例已变化，请重新采集整页。");
        latestRoot = merged.root!;
        const confirmed = await checkedDebugTarget(adbPath, serial, packageName);
        if (confirmed.component !== before.component || confirmed.windowId !== before.windowId || !await sameProcess())
          throw new Error("SDK 补验时窗口已变化，请重新采集整页。");
      }
      const latestList = nodeById(latestRoot, nodeId)!;
      const oldByRef = new Map<string, UiNode>();
      const oldPending = [target];
      for (let cursor = 0; cursor < oldPending.length; cursor++) {
        const old = oldPending[cursor], ref = old.attributes?.["view-ref"];
        if (!ref || oldByRef.has(ref)) throw new Error("原分支控件身份重复，请重新采集整页。");
        oldByRef.set(ref, old);
        oldPending.push(...old.children);
      }
      const requestedRefs = new Set(allRequested.map(node => node.attributes!["view-ref"]));
      const allRefs = new Set<string>();
      const wholeTree = [latestRoot];
      for (let cursor = 0; cursor < wholeTree.length; cursor++) {
        const node = wholeTree[cursor], ref = node.attributes?.["view-ref"];
        if (ref && allRefs.has(ref)) throw new Error("刷新后的控件树包含重复对象身份。");
        if (ref) allRefs.add(ref);
        wholeTree.push(...node.children);
      }
      const oversizedIds = new Set(oversized.map(index => viewportItems[index].id));
      const refreshedAt = new Date().toISOString();
      let refreshed = 0, offViewport = 0;
      const pending: Array<{ node: UiNode; top: boolean }> = [{ node: latestList, top: true }];
      for (let cursor = 0; cursor < pending.length; cursor++) {
        const { node, top } = pending[cursor];
        for (const child of node.children) pending.push({ node: child, top: false });
        const ref = node.attributes?.["view-ref"];
        if (!ref) continue;
        if (requestedRefs.has(ref)) {
          const old = oldByRef.get(ref), image = images.get(ref), kind = kinds.get(ref);
          const sizeMatches = image && node.bounds && image.width === node.bounds.right - node.bounds.left && image.height === node.bounds.bottom - node.bounds.top;
          const attributes = node.attributes = { ...node.attributes };
          delete attributes["image-capture-error"]; delete attributes["image-refresh-error"];
          if (image && sizeMatches) {
            node.layerImageStatus = "captured";
            node.layerImageDataUrl = image.imageDataUrl;
            node.layerImageSize = { width: image.width, height: image.height };
            node.layerImageEmpty = image.empty;
            attributes["image-source"] = kind === "surface" ? "SurfaceView / OpenGL 独立缓冲层" : kind === "texture" ? "TextureView 自身缓冲区" : "按对象身份独立采集，不含子节点";
            attributes["image-refreshed-at"] = refreshedAt;
            refreshed++;
          } else if (!image && skipDraw.has(ref)) {
            node.layerImageStatus = "unavailable";
            attributes["skip-draw"] = "true";
            attributes["image-source"] = "结构容器，系统跳过自身绘制";
            attributes["image-refreshed-at"] = refreshedAt;
            refreshed++;
          } else {
            const reason = image ? "控件画面尺寸已变化，请重试。" : captureFailures.get(ref) ?? "未取得控件独立画面。";
            nodeFailures.push({ id: node.id, message: reason });
            if (old?.layerImageStatus === "captured" && old.layerImageDataUrl && old.bounds?.raw === node.bounds?.raw && old.className === node.className) {
              node.layerImageStatus = old.layerImageStatus;
              node.layerImageDataUrl = old.layerImageDataUrl;
              node.layerImageSize = old.layerImageSize;
              node.layerImageEmpty = old.layerImageEmpty;
              attributes["image-source"] = old.attributes?.["image-source"] ?? "原快照独立画面";
              if (old.attributes?.["image-refreshed-at"]) attributes["image-refreshed-at"] = old.attributes["image-refreshed-at"];
              attributes["image-refresh-error"] = `${reason} 已保留旧画面。`;
            } else {
              node.layerImageStatus = "failed";
              attributes["image-capture-error"] = reason;
              delete attributes["image-source"];
            }
          }
          continue;
        }
        // 未分批的节点：屏外条目（及屏外条目子树）保留旧画面并标注；被跳过的超限条目单独标注。
        const old = oldByRef.get(ref);
        node.layerImageStatus = node.visibleToUser ? "unavailable" : "hidden";
        const attributes = node.attributes = { ...node.attributes };
        if (top && oversizedIds.has(node.id)) {
          attributes["list-item-skipped"] = "true";
          attributes["image-refreshed-at"] = refreshedAt;
        } else {
          attributes["out-of-viewport"] = "true";
          attributes["image-refreshed-at"] = refreshedAt;
          offViewport++;
        }
        if (old?.layerImageStatus === "captured" && old.layerImageDataUrl && old.className === node.className) {
          node.layerImageStatus = old.layerImageStatus;
          node.layerImageDataUrl = old.layerImageDataUrl;
          node.layerImageSize = old.layerImageSize;
          node.layerImageEmpty = old.layerImageEmpty;
          attributes["image-source"] = old.attributes?.["image-source"] ?? "原快照独立画面";
        }
      }
      if (!refreshed) throw new Error(`列表补图全部失败：${nodeFailures[0]?.message ?? "未取得独立画面"}；原快照已保留。`);
      signal?.throwIfAborted();
      console.log(`[list-refresh] 条目分批完成：视口 ${viewportItems.length} 项 / ${batches.length} 批（上限 ${MAX_VIEW_REFRESH_NODES}/批），屏外标注 ${offViewport} 节点，失败 ${nodeFailures.length} 项。`);
      return { nodes: [], failures: nodeFailures, branch: latestList };
    } finally {
      await inspectionContext.exit(() => runDeviceAdb(adbPath, serial, ["forward", "--remove", `tcp:${port}`])).catch(() => undefined);
    }
  });
}

export function parseViewStyleReply(output: string, ref: string, rootRef: string, instance: string, bounds: UiBounds): ViewStyleResult {
  const match = /^Result: Bundle\[\{([^\r\n]{0,2048})\}\]$/.exec(output.trim());
  if (!match) throw new Error("目标 App 的样式读取失败；请确认 Debug SDK 已更新。");
  const fields = new Map<string, string>();
  for (const entry of match[1].split(", ")) {
    const separator = entry.indexOf("=");
    if (separator < 1 || fields.has(entry.slice(0, separator))) throw new Error("样式数据格式无效。");
    fields.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  if (fields.get("result") !== "ok") throw new Error("目标 App 未能读取此控件样式；请确认 Debug SDK 已更新。");
  if (fields.get("ref") !== ref || fields.get("rootRef") !== rootRef || fields.get("processInstance") !== instance)
    throw new Error("控件或窗口身份已变化，请重新采集整页。");
  const coordinate = (key: string) => {
    const raw = fields.get(key);
    if (!raw || !/^-?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error("样式数据中的控件尺寸无效。");
    return Number(raw);
  };
  if (Math.abs(coordinate("x") - bounds.left) > MAX_POSITION_DRIFT_PX
      || Math.abs(coordinate("y") - bounds.top) > MAX_POSITION_DRIFT_PX
      || coordinate("width") !== bounds.right - bounds.left || coordinate("height") !== bounds.bottom - bounds.top)
    throw new Error("控件位置或尺寸已变化，请刷新控件后再读取样式。");
  const capturedAtMillis = coordinate("capturedAtMillis");
  if (capturedAtMillis < 1) throw new Error("样式采集时间无效。");
  const backgroundType = fields.get("backgroundType") ?? null;
  const backgroundColor = fields.get("backgroundColor") ?? null;
  const textColor = fields.get("textColor") ?? null;
  const rawSize = fields.get("textSizePx");
  const textSizePx = rawSize === undefined ? null : Number(rawSize);
  if (backgroundType !== null && !/^[\w.$]{1,512}$/.test(backgroundType)
      || backgroundColor !== null && (!backgroundType || !/^#[0-9A-F]{8}$/.test(backgroundColor))
      || textColor !== null && !/^#[0-9A-F]{8}$/.test(textColor)
      || (textColor === null) !== (rawSize === undefined)
      || textSizePx !== null && (!Number.isFinite(textSizePx) || textSizePx <= 0 || textSizePx > 10_000))
    throw new Error("样式数据无效。");
  return { ref, capturedAtMillis, backgroundType, backgroundColor, textColor, textSizePx };
}

export function captureViewStyle(serial: string, snapshot: UiSnapshot, nodeId: string): Promise<ViewStyleResult> {
  return inspectionContext.run({ allowAppRestart: false }, async () => {
    const root = snapshot.root, target = root && nodeById(root, nodeId);
    const packageName = root?.package, ref = target?.attributes?.["view-ref"];
    const rootRef = root?.children[0]?.attributes?.["view-ref"];
    const instance = root?.attributes?.["sdk-process-instance"];
    const processId = Number(root?.attributes?.["debug-process-id"]);
    const component = root?.attributes?.["debug-component"];
    if (snapshot.inspectionSource !== "debug-hybrid" || root?.attributes?.["sdk-style-version"] !== "1"
        || snapshot.serial !== serial || !packageName || !ref || !rootRef
        || !instance || !component || !target?.bounds || !Number.isSafeInteger(processId) || processId < 1)
      throw new Error("当前快照不支持实时样式，请重新采集接入新版 SDK 的 Debug App。");
    const adbPath = automationAdb(serial);
    const before = await checkedDebugTarget(adbPath, serial, packageName);
    if (before.component !== component || await singleAppPid(adbPath, serial, packageName) !== processId)
      throw new Error("目标 App 或进程已变化，请重新采集整页。");
    const reply = await providerCall(adbPath, serial, packageName, "capture-style", ref, null, COMMAND_TIMEOUT_MS, true);
    if (reply.code !== 0) throw new Error("无法读取目标 App 的实时样式。");
    const style = parseViewStyleReply(reply.stdout.toString("utf8"), ref, rootRef, instance, target.bounds);
    const after = await checkedDebugTarget(adbPath, serial, packageName);
    if (after.component !== before.component || after.windowId !== before.windowId
        || await singleAppPid(adbPath, serial, packageName) !== processId)
      throw new Error("样式读取期间 App 或窗口已变化，请重新采集整页。");
    return style;
  });
}

export function captureQmlGroupImage(serial: string, snapshot: UiSnapshot, nodeId: string, signal?: AbortSignal): Promise<QmlGroupImage | null> {
  return inspectionContext.run({ signal, allowAppRestart: false }, async () => {
    const root = snapshot.root, packageName = root?.package;
    if (snapshot.inspectionSource !== "debug-qml" || !root || !packageName || snapshot.serial !== serial) return null;
    const expected = nodeById(root, nodeId);
    const debugId = Number(expected?.attributes?.["qml-debug-id"]);
    const processId = Number(root.attributes?.["qml-process-id"]);
    const windowId = root.attributes?.["qml-window-id"];
    if (!expected?.bounds || !expected.children.length || !Number.isSafeInteger(debugId) || debugId < 1
      || !Number.isSafeInteger(processId) || processId < 1 || !windowId) return null;
    const adbPath = automationAdb(serial);
    const before = await checkedDebugTarget(adbPath, serial, packageName);
    if (before.windowId !== windowId || processId !== await singleAppPid(adbPath, serial, packageName)) return null;
    const top = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", packageName]);
    if (top.code !== 0) return null;
    const section = targetActivitySection(top.stdout.toString("utf8"), before);
    if (!section.includes("org.qtproject.qt.android.")) return null;
    const captured = await qmlDebugTree(adbPath, serial, before, debugId);
    const current = nodeById(qmlUiTree(captured.root, packageName, appBounds(section)), nodeId);
    const image = captured.images.get(debugId);
    const after = await checkedDebugTarget(adbPath, serial, packageName);
    if (!current || !qmlGroupNodeMatches(expected, current) || !image || captured.processId !== processId
      || after.windowId !== windowId || processId !== await singleAppPid(adbPath, serial, packageName)) return null;
    return { dataUrl: image.dataUrl, size: { width: image.width, height: image.height }, capturedAt: new Date().toISOString() };
  });
}

export function captureViewGroupImage(serial: string, snapshot: UiSnapshot, nodeId: string, signal?: AbortSignal): Promise<QmlGroupImage | null> {
  return inspectionContext.run({ signal, allowAppRestart: false }, async () => {
    const root = snapshot.root, packageName = root?.package;
    const targetId = nodeId === "0" ? "0/0" : nodeId;
    const node = root && nodeById(root, targetId), bounds = node?.bounds;
    const sameBounds = (a: UiNode["bounds"] | undefined, b: UiNode["bounds"] | undefined) => Boolean(a && b && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom);
    const processId = Number(root?.attributes?.["debug-process-id"]);
    const instance = root?.attributes?.["sdk-process-instance"];
    const rootRef = root?.children[0]?.attributes?.["view-ref"];
    const ref = node?.attributes?.["view-ref"];
    const component = root?.attributes?.["debug-component"];
    const pixels = bounds ? (bounds.right - bounds.left) * (bounds.bottom - bounds.top) : 0;
    if (snapshot.inspectionSource !== "debug-hybrid" || snapshot.serial !== serial || !root || !packageName || !node?.children.length
        || (nodeId === "0" && !sameBounds(root.bounds, bounds))
        || !node.visibleToUser || !bounds || pixels < 1 || pixels > 4_000_000 || !ref || !rootRef || !instance || !component
        || !Number.isSafeInteger(processId) || processId < 1) return null;
    const adbPath = automationAdb(serial);
    const before = await checkedDebugTarget(adbPath, serial, packageName);
    if (before.component !== component || processId !== await singleAppPid(adbPath, serial, packageName)) return null;
    const firstTree = await readSdkCapture(adbPath, serial, packageName);
    if (!sdkGroupBranchMatches(root, targetId, firstTree, packageName, processId, instance)) return null;
    try {
      const reply = await providerCall(adbPath, serial, packageName, "capture-group", ref, null, COMMAND_TIMEOUT_MS, true);
      const output = reply.stdout.toString("utf8");
      const field = (name: string) => new RegExp(`\\b${name}=([^,}\\]]+)`).exec(output)?.[1];
      if (reply.code !== 0 || field("result") !== "ok" || field("ref") !== ref || field("rootRef") !== rootRef
          || field("processInstance") !== instance || !/^[a-f0-9]{64}$/.test(field("sha256") ?? "")) return null;
      const file = await runDeviceAdb(adbPath, serial, ["exec-out", "run-as", packageName, "head", "-c", "20000001", "no_backup/inspector-group-image.png"]);
      const size = pngSize(file.stdout);
      if (file.code !== 0 || !size || file.stdout.length > 20_000_000 || size.width !== bounds.right - bounds.left
          || size.height !== bounds.bottom - bounds.top || createHash("sha256").update(file.stdout).digest("hex") !== field("sha256")) return null;
      const secondTree = await readSdkCapture(adbPath, serial, packageName);
      const after = await checkedDebugTarget(adbPath, serial, packageName);
      signal?.throwIfAborted();
      if (!sdkGroupBranchMatches(root, targetId, secondTree, packageName, processId, instance)
          || before.windowId !== after.windowId || before.component !== after.component
          || processId !== await singleAppPid(adbPath, serial, packageName)) return null;
      return { dataUrl: `data:image/png;base64,${file.stdout.toString("base64")}`, size, capturedAt: new Date().toISOString() };
    } finally {
      await inspectionContext.exit(() => runDeviceAdb(adbPath, serial, ["shell", "run-as", packageName, "rm", "-f", "no_backup/inspector-group-image.png"])).catch(() => undefined);
    }
  });
}

async function captureScreen(adbPath: string, serial: string) {
  const beforeScreenshot = await readDisplayFrame(adbPath, serial);
  const result = await runDeviceAdb(adbPath, serial, ["exec-out", "screencap", "-p"]);
  const screenshotSize = pngSize(result.stdout);
  if (result.code !== 0 || !screenshotSize) return { result, screenshotDataUrl: null, captureGeometry: undefined };
  const afterScreenshot = await readDisplayFrame(adbPath, serial);
  const captureGeometry: CaptureGeometry = { hierarchyRotation: beforeScreenshot?.rotation ?? null, beforeScreenshot, afterScreenshot, screenshotSize };
  return {
    result,
    screenshotDataUrl: `data:image/png;base64,${result.stdout.toString("base64")}`,
    captureGeometry,
  };
}

function errorSnapshot(serial: string, error: string): UiSnapshot {
  return {
    serial,
    root: null,
    nodeCount: 0,
    xmlSize: 0,
    rawXml: null,
    screenshotDataUrl: null,
    error,
    warning: null,
  };
}

export async function probeAdb(): Promise<AdbProbeResult> {
  const adbPath = findAdbPath();
  if (!adbPath) {
    return {
      adbPath: null,
      adbVersion: null,
      devices: [],
      error: "未找到 adb。请安装 Android SDK Platform-Tools 后重试。",
    };
  }

  let adbVersion: string | null = null;
  try {
    const versionResult = await runAdb(adbPath, ["version"]);
    adbVersion = versionResult.stdout
      .toString("utf8")
      .split(/\r?\n/)
      .find((line) => line.includes("Android Debug Bridge version"))
      ?.trim() ?? null;

    const devicesResult = await runAdb(adbPath, ["devices", "-l"]);
    if (devicesResult.code !== 0) {
      return {
        adbPath,
        adbVersion,
        devices: [],
        error: commandError("adb 无法读取设备列表", devicesResult),
      };
    }

    const devices = devicesResult.stdout
      .toString("utf8")
      .split(/\r?\n/)
      .map(parseDeviceLine)
      .filter((device): device is DeviceInfo => device !== null);
    const enrichedDevices = await Promise.all(devices.map(async (device) => device.state === "device"
      ? { ...device, androidVersion: await readAndroidVersion(adbPath, device.serial) }
      : device));

    return {
      adbPath,
      adbVersion,
      devices: enrichedDevices,
      error: null,
    };
  } catch (error) {
    return {
      adbPath,
      adbVersion,
      devices: [],
      error: error instanceof Error ? error.message : "执行 adb 失败。",
    };
  }
}

export function inspectDevice(serial: string, options: InspectionOptions = {}): Promise<UiSnapshot> {
  return inspectionContext.run(options, () => readDeviceSnapshot(serial, options));
}

async function readSdkCapture(adbPath: string, serial: string, packageName: string): Promise<unknown> {
  let reply = await providerCall(adbPath, serial, packageName, "capture", null, null, COMMAND_TIMEOUT_MS);
  if (reply.stdout.toString("utf8").includes("error=View tree timed out")) reply = await providerCall(adbPath, serial, packageName, "capture", null, null, COMMAND_TIMEOUT_MS);
  if (reply.stdout.toString("utf8").includes("error=View tree timed out")) {
    throw new Error("SDK 控件树连续超时：目标 App 页面尚未就绪，请稍后重试。");
  }
  if (reply.code !== 0 || reply.stdout.toString("utf8").trim() !== "Result: Bundle[{result=ok}]") {
    const status = reply.stdout.toString("utf8").trim().slice(0, 160) || `code=${reply.code} stdout 空`;
    throw new Error(`目标 App 的 Debug SDK 控件树读取失败（${status}）`);
  }
  // The SDK caps its private file at 4 MB; head adds a host-side read cap.
  const file = await runDeviceAdb(adbPath, serial, ["exec-out", "run-as", packageName, "head", "-c", "4000001", "no_backup/inspector-hierarchy.json"]);
  if (file.code !== 0 || !file.stdout.length || file.stdout.length > 4_000_000) throw new Error("SDK 控件树文件无效或超过 4 MB");
  return JSON.parse(file.stdout.toString("utf8")) as unknown;
}

async function singleAppPid(adbPath: string, serial: string, packageName: string) {
  const result = await runDeviceAdb(adbPath, serial, ["shell", "pidof", "-s", packageName]);
  const value = result.stdout.toString("utf8").trim();
  if (result.code !== 0 || !/^\d+$/.test(value)) throw new Error("无法确认 SDK 前台 App 主进程");
  return Number(value);
}

/** Explicit experiment: SDK owns the tree; DDMS/JDWP still owns independent pixels. */
export function inspectHybridDevice(serial: string, packageName: string, options: InspectionOptions = {}): Promise<UiSnapshot> {
  return inspectionContext.run(options, async () => {
    const adbPath = automationAdb(serial);
    const before = await checkedDebugTarget(adbPath, serial, packageName);
    const expectedPid = await singleAppPid(adbPath, serial, packageName);
    options.onProgress?.("读取 SDK 控件树", 0);
    const sdk = await readSdkCapture(adbPath, serial, packageName);
    const snapshot = await inspectDevice(serial, { ...options, expectedPackage: packageName });
    if (snapshot.error) throw new Error(snapshot.error);
    const after = await checkedDebugTarget(adbPath, serial, packageName);
    if (before.component !== after.component || before.windowId !== after.windowId || expectedPid !== await singleAppPid(adbPath, serial, packageName)) {
      throw new Error("SDK 与独立画面采集期间进程或窗口已变化");
    }
    return joinSdkTreeAndDebugImages(snapshot, sdk, packageName, expectedPid);
  });
}

/** Existing capture remains the fallback; never attach SDK data when identity checks fail. */
export function inspectPreferredDevice(serial: string, options: InspectionOptions = {}): Promise<UiSnapshot> {
  return inspectionContext.run(options, async () => {
    const started = performance.now();
    const retryDeadline = started + STARTUP_RETRY_TIMEOUT_MS;
    const sdkState: { capture: { packageName: string; pid: number; component: string; windowId: string; tree: unknown } | null; error: unknown } = { capture: null, error: null };
    const captureOptions: InspectionOptions = { ...options, pinFirstComponent: null, onViewTreeReady: async (packageName, root, mode, prefetched) => {
      if (!/^[\w]+(?:\.[\w]+)+$/.test(packageName)) return;
      try {
        const adbPath = automationAdb(serial);
        let pid: number, component: string, windowId: string, tree: unknown;
        if (prefetched !== undefined) {
          // Merged capture: this tree came with the visible call. Identity stays pinned to the
          // capture-start values; the end-of-capture join still re-checks the whole hierarchy.
          const expectedPid = Number(root.attributes?.["debug-process-id"]);
          if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0) throw new Error("SDK 与独立画面主进程不一致");
          const confirmed = await checkedDebugTarget(adbPath, serial, packageName);
          if (confirmed.component !== root.attributes?.["debug-component"]) throw new Error("进程或窗口已变化");
          pid = expectedPid; component = confirmed.component; windowId = confirmed.windowId; tree = prefetched;
        } else {
          const installed = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "package", packageName]);
          if (installed.code !== 0 || !installed.stdout.toString("utf8").includes(`${packageName}/com.androiduiinspector.sdk.HierarchyProvider:`)) return;
          const before = await checkedDebugTarget(adbPath, serial, packageName);
          pid = await singleAppPid(adbPath, serial, packageName);
          if (root.attributes?.["debug-process-id"] !== String(pid)) throw new Error("SDK 与独立画面主进程不一致");
          tree = await readSdkCapture(adbPath, serial, packageName);
          const after = await checkedDebugTarget(adbPath, serial, packageName);
          if (before.component !== after.component || before.windowId !== after.windowId || pid !== await singleAppPid(adbPath, serial, packageName)) throw new Error("进程或窗口已变化");
          component = before.component; windowId = before.windowId;
        }
        if (tree && typeof tree === "object" && "visibleStreamVersion" in tree && (tree.visibleStreamVersion === 1 || tree.visibleStreamVersion === 2)) {
          root.attributes = { ...root.attributes, "sdk-visible-stream": String(tree.visibleStreamVersion) };
        }
        try {
          if (mode === "adopt") {
            adoptSdkTree(root, tree, packageName, pid);
            root.attributes = { ...root.attributes, "sdk-tree-source": "merged" };
          } else verifySdkTreeBeforeImages(root, countNodes(root), tree, packageName, pid);
          sdkState.error = null;
          sdkState.capture = { packageName, pid, component, windowId, tree };
          if (prefetched !== undefined) root.attributes = { ...root.attributes, "sdk-tree-source": "merged" };
        } catch (error) {
          // A changing sibling invalidates SDK properties, not an own bitmap
          // whose View identity, size and screen position are checked again below.
          if (!(error instanceof Error && error.message.startsWith("SDK 与独立画面的"))) throw error;
          sdkState.error = error;
        }
        // ponytail: tiny trees keep the cheaper DDMS path; retune 200 after broader device samples.
        if (options.preferVisibleSdk === true || options.preferVisibleSdk === undefined && countNodes(root) >= 200) {
          captureOptions.preferVisibleSdk = true;
          const activeCapture = inspectionContext.getStore();
          if (activeCapture) activeCapture.preferVisibleSdk = true;
        }
      } catch (error) {
        sdkState.error = error;
        if (error instanceof Error && /SDK 与独立画面的|SDK 控件树连续超时/.test(error.message)
            && performance.now() < retryDeadline) throw new Error(`App 正在初始化：${error.message}`);
        if (error instanceof Error && error.message.startsWith("SDK 控件树连续超时")) throw error;
      }
    } };
    let snapshot: UiSnapshot;
    do {
      sdkState.capture = null;
      sdkState.error = null;
      captureOptions.preferVisibleSdk = options.preferVisibleSdk;
      snapshot = await inspectDevice(serial, captureOptions);
      if (!snapshot.error || !(snapshot.error.startsWith("App 仍在启动") || snapshot.error.startsWith("前台 App 在 18 秒内未准备好"))
          || performance.now() + 2_000 >= retryDeadline) break;
      options.signal?.throwIfAborted();
      captureOptions.startupRetry = true;
      options.onProgress?.("等待 App 页面稳定", Math.round(performance.now() - started));
      await wait(2_000, undefined, { signal: options.signal });
    } while (true);
    if (snapshot.error || snapshot.inspectionSource !== "debug-view" || !sdkState.capture && !sdkState.error) return snapshot;
    try {
      if (sdkState.error) throw sdkState.error;
      const capture = sdkState.capture!;
      const adbPath = automationAdb(serial);
      const after = await checkedDebugTarget(adbPath, serial, capture.packageName);
      if (snapshot.root?.package !== capture.packageName || snapshot.root.attributes?.["debug-process-id"] !== String(capture.pid)
          || capture.component !== after.component || capture.windowId !== after.windowId || capture.pid !== await singleAppPid(adbPath, serial, capture.packageName)) {
        throw new Error("进程或窗口已变化");
      }
      return joinSdkTreeAndDebugImages(snapshot, capture.tree, capture.packageName, capture.pid);
    } catch (error) {
      return { ...snapshot, warning: [snapshot.warning, `SDK 树未采用（${error instanceof Error ? error.message : "未知错误"}）；已保留原独立画面。`].filter(Boolean).join(" ") };
    }
  });
}

async function readDeviceSnapshot(serial: string, options: InspectionOptions): Promise<UiSnapshot> {
  const started = performance.now();
  let stageStart = started;
  let currentStage = "";
  const timings: Record<string, number> = {};
  const stage = (name: string) => {
    options.signal?.throwIfAborted();
    const now = performance.now();
    if (currentStage) timings[currentStage] = Math.round(now - stageStart);
    currentStage = name;
    stageStart = now;
    options.onProgress?.(name, Math.round(now - started));
  };
  if (!serial.trim()) return errorSnapshot(serial, "设备序列号不能为空。");

  const adbPath = findAdbPath();
  if (!adbPath) return errorSnapshot(serial, "未找到 adb。请安装 Android SDK Platform-Tools 后重试。");

  try {
    stage("检查前台 Debug App");
    const activities = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", "activities"]);
    if (activities.code !== 0) return errorSnapshot(serial, commandError("无法读取前台 App", activities));
    let target = foregroundTarget(activities.stdout.toString("utf8"));
    const readinessDeadline = started + APP_READY_TIMEOUT_MS;
    let startupWaited = options.startupRetry === true;
    if (!target) {
      startupWaited = true;
      const foregroundDeadline = Math.min(readinessDeadline, performance.now() + 2_000);
      stage("等待前台 App 就绪");
      while (!target && performance.now() < foregroundDeadline) {
        await wait(Math.min(500, Math.max(1, readinessDeadline - performance.now())), undefined, { signal: options.signal });
        if (performance.now() >= readinessDeadline) break;
        const current = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", "activities"], Math.max(1, Math.ceil(readinessDeadline - performance.now())));
        if (current.code !== 0) return errorSnapshot(serial, commandError("无法读取前台 App", current));
        target = foregroundTarget(current.stdout.toString("utf8"));
      }
      if (!target) return errorSnapshot(serial, "未发现前台 App，请等待页面启动后重试。");
    }
    if (options.expectedPackage && target.packageName !== options.expectedPackage) throw new Error("前台 App 已变化，已拒绝采集未授权的 App。");
    if (options.pinFirstComponent === null) options.pinFirstComponent = target.component;
    else if (options.pinFirstComponent && options.pinFirstComponent !== target.component) throw new Error("重新采集时前台 App 已变化，已停止采集。");

    const debugCheck = await runDeviceAdb(adbPath, serial, ["shell", "run-as", target.packageName, "id"]);
    if (debugCheck.code !== 0) return errorSnapshot(serial, `仅支持 Debug App：${target.packageName} 不可调试。`);
    // Open the persistent provider session early: its one-time open cost hides behind the tree read.
    void openProviderSession(adbPath, serial, target.packageName);

    stage("读取控件树");
    const top = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", target.packageName]);
    if (top.code !== 0) return errorSnapshot(serial, commandError("无法读取 Debug App 层级", top));
    const activitySection = (output: Buffer) => {
      const text = output.toString("utf8");
      return text.includes(`ACTIVITY ${target.component} `) ? targetActivitySection(text, target) : "";
    };
    let section = activitySection(top.stdout);
    if (!hasActivityHierarchy(section, target)) {
      startupWaited = true;
      // ponytail: this Android 14 App needed 12–13 s to expose its tree; keep a bounded, adjustable budget.
      const deadline = readinessDeadline;
      let focusReady = false;
      stage("等待 App 控件树就绪");
      try {
        while (performance.now() < deadline) {
          await wait(Math.min(500, Math.max(1, deadline - performance.now())), undefined, { signal: options.signal });
          // Never issue a dumpsys read with a token timeout: the child is killed mid-dump, and an
          // app whose dump is already slow can fall into an EPIPE loop instead of finishing. Stop
          // retrying while reads still have a realistic budget.
          if (deadline - performance.now() < APP_READY_MIN_READ_MS) break;
          const foreground = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", "activities"], Math.max(APP_READY_MIN_READ_MS, Math.ceil(deadline - performance.now())));
          if (foreground.code !== 0) throw new Error(commandError("等待控件树时无法确认前台 App", foreground));
          if (foregroundTarget(foreground.stdout.toString("utf8"))?.component !== target.component) throw new Error("等待控件树时前台 App 已变化，已停止采集。");
          if (deadline - performance.now() < APP_READY_MIN_READ_MS) break;
          const refreshed = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", target.packageName], Math.max(APP_READY_MIN_READ_MS, Math.ceil(deadline - performance.now())));
          if (refreshed.code !== 0) throw new Error(commandError("等待控件树时无法读取 App 层级", refreshed));
          section = activitySection(refreshed.stdout);
          if (hasActivityHierarchy(section, target)) {
            try {
              const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now())));
              const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
              focusReady = (await inspectionContext.run({ ...options, signal }, () => checkedDebugTarget(adbPath, serial, target.packageName))).component === target.component;
            }
            catch { options.signal?.throwIfAborted(); }
            if (focusReady) {
              if (deadline - performance.now() < APP_READY_MIN_READ_MS) break;
              const focused = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", target.packageName], Math.max(APP_READY_MIN_READ_MS, Math.ceil(deadline - performance.now())));
              if (focused.code !== 0) throw new Error(commandError("无法读取焦点窗口层级", focused));
              section = activitySection(focused.stdout);
              if (hasActivityHierarchy(section, target)) break;
            }
          }
        }
      } catch (error) {
        options.signal?.throwIfAborted();
        if (!(error instanceof Error && error.message.startsWith("命令执行超时"))) throw error;
      }
      if (!focusReady || !hasActivityHierarchy(section, target)) throw new Error("前台 App 在 18 秒内未准备好控件树和焦点窗口，请等待页面就绪后重试。");
      stage("读取控件树");
    }
    const isQml = section.includes("org.qtproject.qt.android.");
    let root: UiNode;
    let inspectionSource: UiSnapshot["inspectionSource"];
    let warning: string | null = null;
    let rawHierarchy: string;
    let qmlIdentity: { processId: number; windowId: string } | null = null;
    let prestartedScreen: Promise<Awaited<ReturnType<typeof captureScreen>> | null> | null = null;

    if (isQml) {
      const qml = await qmlDebugTree(adbPath, serial, target);
      root = qmlUiTree(qml.root, target.packageName, appBounds(section), qml.images);
      const confirmed = await checkedDebugTarget(adbPath, serial, target.packageName);
      if (confirmed.component !== target.component || qml.processId !== await singleAppPid(adbPath, serial, target.packageName)) throw new Error("Qt App 进程或窗口已变化，请重新采集。");
      qmlIdentity = { processId: qml.processId, windowId: confirmed.windowId };
      root.attributes!["qml-process-id"] = String(qml.processId);
      root.attributes!["qml-window-id"] = confirmed.windowId;
      inspectionSource = "debug-qml";
      rawHierarchy = JSON.stringify(qml.root);
      if (qml.restarted) warning = "已重启目标 App 并建立 QML Debug 连接。";
      if (qml.captureWarning) warning = [warning, qml.captureWarning].filter(Boolean).join(" ");
    } else {
      root = debugViewTree(section, target);
      root.attributes = { ...root.attributes, "debug-component": target.component };
      inspectionSource = "debug-view";
      rawHierarchy = section;
      stage("读取完整控件属性");
      const imageSignal = captureSignal(options.signal, startupWaited ? STARTUP_IMAGE_TIMEOUT_MS : IMAGE_TIMEOUT_MS);
      try {
        let previewScreen: Awaited<ReturnType<typeof captureScreen>> | null = null;
        let previewScreenTask: Promise<void> | null = null;
        const beginTreeScreen = () => previewScreenTask ??= (async () => {
          try {
            const signal = captureSignal(inspectionContext.getStore()?.signal, PREVIEW_SCREEN_TIMEOUT_MS);
            const screen = await inspectionContext.run({ ...options, signal }, () => captureScreen(adbPath, serial));
            if (screen.screenshotDataUrl && screen.captureGeometry && assessCaptureGeometry(screen.captureGeometry).status === "checked") previewScreen = screen;
          } catch { options.signal?.throwIfAborted(); }
        })();
        const preview: InspectionPreview | undefined = options.onPreview ? Object.assign(async (phase: "tree" | "layers") => {
          try {
            if (phase === "tree") {
              stage("读取首屏预览");
              await beginTreeScreen();
            }
            const foreground = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", "activities"]);
            if (foreground.code !== 0 || foregroundTarget(foreground.stdout.toString("utf8"))?.component !== target.component) return;
            options.signal?.throwIfAborted();
            options.onPreview?.(phase, {
              serial, root, nodeCount: countNodes(root), xmlSize: Buffer.byteLength(rawHierarchy, "utf8"), rawXml: null,
              screenshotDataUrl: previewScreen?.screenshotDataUrl ?? null, captureGeometry: previewScreen?.captureGeometry,
              error: null, warning: null, inspectionSource: "debug-view",
              captureDurationMs: Math.round(performance.now() - started),
            });
          } catch {
            options.signal?.throwIfAborted();
          }
        }, { beginTreeScreen }) : undefined;
        const images = await inspectionContext.run({ ...options, signal: imageSignal }, () => captureDebugViewImages(adbPath, serial, target.packageName, root, stage, preview, timings));
        const imageCount = images.imageCount;
        prestartedScreen = images.finalScreen;
        if (imageCount === 0) warning = "未读取到独立 View 画面，缺失画面的控件仅显示边框。";
        if (root.attributes?.["texture-capture-warning"]) warning = root.attributes["texture-capture-warning"];
      } catch (error) {
        options.signal?.throwIfAborted();
        if (imageSignal.aborted) throw new Error(startupWaited
          ? "App 冷启动后 55 秒仍未完成独立画面采集，请等待页面稳定后重试。"
          : "独立画面采集超过 90 秒，请等待页面稳定后重试。");
        if (error instanceof Error && (/Debug V2|Debug 窗口与当前控件树不一致|Debug 窗口身份已变化|App 正在初始化/.test(error.message)
            || startupWaited && /SDK 控件树连续超时|Debug View 连接超时/.test(error.message))) {
          throw new Error(`App 仍在启动，独立画面尚未就绪，请等待页面稳定后重试。${error.message}`);
        }
        const pending = [...root.children];
        while (pending.length) {
          const node = pending.pop()!;
          node.layerImageStatus ??= node.visibleToUser ? "failed" : "hidden";
          pending.push(...node.children);
        }
        warning = `独立 View 画面抓取失败，缺失画面的控件仅显示边框。${error instanceof Error ? error.message : ""}`;
      }
      const pending = [...root.children];
      let ambiguous = 0, outsideWindow = 0;
      while (pending.length) {
        const node = pending.pop()!;
        node.layerImageStatus ??= node.visibleToUser ? "unavailable" : "hidden";
        if (node.layerImageStatus === "ambiguous") {
          ambiguous++;
          const b = node.bounds, window = root.bounds;
          if (b && window && (b.right <= window.left || b.bottom <= window.top || b.left >= window.right || b.top >= window.bottom)) outsideWindow++;
        }
        pending.push(...node.children);
      }
      if (ambiguous) warning = [warning, `${ambiguous} 个控件的位图无法唯一匹配${outsideWindow ? `（其中 ${outsideWindow} 个在当前窗口范围外）` : ""}，已保留边框，未混用其他控件画面。`].filter(Boolean).join(" ");
    }

    stage("读取屏幕并校验前台窗口");
    let screenshot: Awaited<ReturnType<typeof captureScreen>> | null = null;
    if (prestartedScreen) screenshot = await prestartedScreen;
    if (!screenshot) {
      try {
        const signal = captureSignal(options.signal, FINAL_SCREEN_TIMEOUT_MS);
        screenshot = await inspectionContext.run({ ...options, signal }, () => captureScreen(adbPath, serial));
      } catch { options.signal?.throwIfAborted(); }
    }
    const after = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", "activities"]);
    if (after.code !== 0 || foregroundTarget(after.stdout.toString("utf8"))?.component !== target.component) {
      return errorSnapshot(serial, "采集期间前台窗口发生变化或无法校验，请保持页面稳定后重新采集。");
    }
    if (qmlIdentity) {
      const confirmed = await checkedDebugTarget(adbPath, serial, target.packageName);
      if (confirmed.windowId !== qmlIdentity.windowId || qmlIdentity.processId !== await singleAppPid(adbPath, serial, target.packageName)) {
        return errorSnapshot(serial, "Qt App 进程或窗口已变化，请重新采集。");
      }
    }
    if (!screenshot?.screenshotDataUrl) {
      warning = [warning, screenshot
        ? commandError("控件树已读取，但截图失败或不是有效 PNG", screenshot.result)
        : "控件树已读取，但截图超时或读取失败。"].filter(Boolean).join(" ");
    } else if (screenshot.captureGeometry) {
      const integrity = assessCaptureGeometry(screenshot.captureGeometry);
      if (integrity.status === "mismatch") warning = [warning, integrity.message].filter(Boolean).join(" ");
    }

    if (!root.children.length) return errorSnapshot(serial, "采集到空控件树，请保持页面稳定后重新采集。");
    stage("完成");
    return {
      serial,
      root,
      nodeCount: countNodes(root),
      xmlSize: Buffer.byteLength(rawHierarchy, "utf8"),
      rawXml: null,
      screenshotDataUrl: screenshot?.screenshotDataUrl ?? null,
      error: null,
      warning,
      inspectionSource,
      captureTimings: timings,
      captureDurationMs: Math.round(performance.now() - started),
      ...(screenshot?.captureGeometry ? { captureGeometry: screenshot.captureGeometry } : {}),
    };
  } catch (error) {
    options.signal?.throwIfAborted();
    return errorSnapshot(serial, error instanceof Error ? error.message : "读取 Debug 控件树失败。");
  }
}

export type DebugTarget = ForegroundTarget & { windowId: string };

export function parseFocusedWindow(output: string): { id: string; packageName: string } | null {
  const focusedDisplay = output.match(/mTopFocusedDisplayId=(\d+)/)?.[1];
  if (focusedDisplay && focusedDisplay !== "0") return null;
  if (/Display: mDisplayId=/.test(output)) {
    const display = output.match(/Display: mDisplayId=0\b[\s\S]*?(?=\n\s*Display: mDisplayId=|$)/)?.[0];
    if (!display) return null;
    output = display;
  }
  if ((output.match(/mCurrentFocus=/g) ?? []).length !== 1) return null;
  const match = output.match(/mCurrentFocus=Window\{([0-9a-f]+)\s+u\d+\s+([\w.]+)\//i);
  return match ? { id: match[1], packageName: match[2] } : null;
}

async function checkedDebugTarget(adbPath: string, serial: string, expectedPackage?: string): Promise<DebugTarget> {
  const activities = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", "activities"]);
  const target = foregroundTarget(activities.stdout.toString("utf8"));
  if (activities.code !== 0 || !target || !/^[\w]+(?:\.[\w]+)+$/.test(target.packageName)) throw new Error("无法确认前台 App。");
  if (expectedPackage && target.packageName !== expectedPackage) throw new Error("前台 App 已离开授权范围，未执行操作。");
  const debug = await runDeviceAdb(adbPath, serial, ["shell", "run-as", target.packageName, "id"]);
  if (debug.code !== 0) throw new Error(`仅支持 Debug App：${target.packageName} 不可调试。`);
  const windows = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "window", "windows"]);
  let focusOutput = windows.stdout.toString("utf8");
  // Newer Android versions put per-display focus in `displays`, not `windows`.
  if (!focusOutput.includes("mCurrentFocus=")) {
    const displays = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "window", "displays"]);
    if (displays.code !== 0) throw new Error("无法读取前台窗口焦点。");
    focusOutput += `\n${displays.stdout.toString("utf8")}`;
  }
  const focus = parseFocusedWindow(focusOutput);
  if (windows.code !== 0 || focus?.packageName !== target.packageName) throw new Error("焦点窗口不属于授权 App，或无法确认窗口；请关闭系统弹窗后重试。");
  return { ...target, windowId: focus.id };
}

function automationAdb(serial: string) {
  if (!/^[\w.:-]{1,256}$/.test(serial)) throw new Error("设备序列号无效。");
  const path = findAdbPath();
  if (!path) throw new Error("未找到 ADB。");
  return path;
}

export function getDebugTarget(serial: string, expectedPackage?: string, signal?: AbortSignal) {
  return inspectionContext.run({ signal }, () => checkedDebugTarget(automationAdb(serial), serial, expectedPackage));
}

export function observeDebugApp(serial: string, packageName: string, mode: "fast" | "deep", signal?: AbortSignal): Promise<{ snapshot: UiSnapshot; target: DebugTarget }> {
  return inspectionContext.run({ signal }, async () => {
    const started = performance.now();
    const adbPath = automationAdb(serial);
    const before = await checkedDebugTarget(adbPath, serial, packageName);
    let snapshot: UiSnapshot;
    if (mode === "deep") {
      snapshot = await inspectPreferredDevice(serial, { signal, expectedPackage: packageName, allowAppRestart: false });
      if (snapshot.error) throw new Error(snapshot.error);
    } else {
      // One unique temporary file per request; never consume a previous dump after failure.
      const remote = `/data/local/tmp/android-ui-inspector-${randomUUID()}.xml`;
      let xml: string;
      try {
        const dump = await runCommand(adbPath, ["-s", serial, "shell", "uiautomator", "dump", remote], 15_000);
        if (dump.code !== 0) throw new Error(commandError("轻量控件读取失败", dump));
        const read = await runDeviceAdb(adbPath, serial, ["exec-out", "cat", remote]);
        xml = read.stdout.toString("utf8");
        if (read.code !== 0 || !xml.includes("<hierarchy") || read.stdout.length > 8 * 1024 * 1024) throw new Error("未获得有效的新控件树；不会用旧快照判断成功。");
      } finally {
        await inspectionContext.exit(() => runCommand(adbPath, ["-s", serial, "shell", "rm", "-f", remote], 3_000)).catch(() => undefined);
      }
      const parsed = parseUiHierarchy(xml);
      if (parsed.root.package !== packageName) throw new Error("读取到其他窗口的控件树，已拒绝继续。");
      const screen = await captureScreen(adbPath, serial);
      if (!screen.screenshotDataUrl || !screen.captureGeometry) throw new Error("截图失败，无法核对点击位置。");
      snapshot = {
        serial, root: parsed.root, nodeCount: countNodes(parsed.root), xmlSize: Buffer.byteLength(xml), rawXml: xml,
        screenshotDataUrl: screen.screenshotDataUrl, error: null,
        warning: "自动调试：轻量模式读取无障碍语义节点，不是完整绘制层级；独立图层请使用深度采集。",
        inspectionSource: "uiautomator", hierarchyDumpMode: "full",
        captureGeometry: { ...screen.captureGeometry, hierarchyRotation: parsed.rotation },
      };
    }
    const after = await checkedDebugTarget(adbPath, serial, packageName);
    if (before.component !== after.component || before.windowId !== after.windowId) throw new Error("采集期间窗口发生变化，请重新观察。");
    if (assessCaptureGeometry(snapshot.captureGeometry).status !== "checked") throw new Error("无法确认屏幕方向和尺寸，已暂停自动操作。");
    return { snapshot: { ...snapshot, captureMode: mode, captureDurationMs: Math.round(performance.now() - started) }, target: after };
  });
}

export type DebugInputAction =
  | { kind: "tap"; x: number; y: number }
  | { kind: "swipe"; fromX: number; fromY: number; toX: number; toY: number; durationMs: number }
  | { kind: "back" };

export function debugInputArgs(action: DebugInputAction): string[] {
  if (action.kind === "back") return ["-d", "0", "keyevent", "KEYCODE_BACK"];
  if (action.kind !== "tap" && action.kind !== "swipe") throw new Error("不支持的调试操作。");
  const coordinates = action.kind === "tap" ? [action.x, action.y] : [action.fromX, action.fromY, action.toX, action.toY];
  if (!coordinates.every(value => Number.isSafeInteger(value) && value >= 0 && value <= 100_000)) throw new Error("操作坐标无效。");
  if (action.kind === "swipe" && (!Number.isSafeInteger(action.durationMs) || action.durationMs < 150 || action.durationMs > 1000
    || (action.fromX === action.toX && action.fromY === action.toY))) throw new Error("滑动参数无效。");
  return ["touchscreen", "-d", "0", action.kind, ...coordinates.map(String), ...(action.kind === "swipe" ? [String(action.durationMs)] : [])];
}

export function inputDebugApp(serial: string, target: DebugTarget, action: DebugInputAction, frame: DisplayFrame, signal?: AbortSignal) {
  return inspectionContext.run({ signal }, async () => {
    const args = debugInputArgs(action);
    const adbPath = automationAdb(serial);
    const fresh = await checkedDebugTarget(adbPath, serial, target.packageName);
    if (fresh.windowId !== target.windowId || fresh.component !== target.component) throw new Error("操作前窗口已变化，未执行操作。");
    const display = await readDisplayFrame(adbPath, serial);
    if (!display || display.width !== frame.width || display.height !== frame.height || display.rotation !== frame.rotation) throw new Error("操作前屏幕方向或尺寸已变化，未执行操作。");
    const points = action.kind === "back" ? [] : action.kind === "tap" ? [[action.x, action.y]] : [[action.fromX, action.fromY], [action.toX, action.toY]];
    if (points.some(([x, y]) => x >= display.width || y >= display.height)) throw new Error("操作坐标不在屏幕内。");
    signal?.throwIfAborted();
    const result = await runCommand(adbPath, ["-s", serial, "shell", "input", ...args], 5_000);
    if (result.code !== 0) throw new Error("操作执行失败，结果未知；请重新观察，不要自动重试。");
  });
}
