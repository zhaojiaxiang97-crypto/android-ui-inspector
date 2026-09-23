import { XMLParser } from "fast-xml-parser";
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as wait } from "node:timers/promises";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { AdbProbeResult, CaptureGeometry, DeviceInfo, UiBounds, UiNode, UiSnapshot } from "../shared/types";
import { assessCaptureGeometry, isRotation } from "../shared/screen-coordinates";
import { parseInputDisplay, pngSize } from "./capture-display";
import { inspectQmlHierarchy, type QmlDebugNode } from "./qml-debug";
import { captureViewLayers, captureViewBitmaps, matchesViewRoot, type CapturedViewLayer } from "./view-debug";
import { qmlColorCss, qmlStyleSvg } from "../shared/qml-style";
import { textureDimensions } from "../shared/layer-textures";

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_UI_HIERARCHY_DEPTH = 200;
const QML_DEBUG_PORT = 3768;
const qmlDebugTargets = new Map<string, string>();
type InspectionOptions = { signal?: AbortSignal; onProgress?: (stage: string, elapsedMs: number) => void };
// Task-local cancellation also covers nested ADB commands, without affecting probes.
const inspectionContext = new AsyncLocalStorage<InspectionOptions>();

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

async function runDeviceAdb(adbPath: string, serial: string, args: string[]) {
  return runAdb(adbPath, ["-s", serial, ...args]);
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
    if (!layer.visible || !layer.pngDataUrl || layer.width < 1 || layer.height < 1) continue;
    const id = key(layer.viewRef ?? layer.name, layer.x + windowOrigin.x, layer.y + windowOrigin.y, layer.width, layer.height);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let attached = 0;
  for (const layer of layers) {
    if (!layer.visible || !layer.pngDataUrl || layer.width < 1 || layer.height < 1) continue;
    const id = key(layer.viewRef ?? layer.name, layer.x + windowOrigin.x, layer.y + windowOrigin.y, layer.width, layer.height);
    const matches = candidates.get(id) ?? [];
    if (matches.length !== 1 || counts.get(id) !== 1) {
      for (const node of matches) if (node.layerImageStatus !== "captured") node.layerImageStatus = "ambiguous";
      continue;
    }
    const node = matches[0];
    if (node.layerImageStatus === "captured") continue;
    node.layerImageDataUrl = layer.pngDataUrl;
    node.layerImageSize = { width: layer.width, height: layer.height };
    node.layerImageStatus = "captured";
    attached += 1;
  }
  return attached;
}

async function captureDebugViewImages(adbPath: string, serial: string, packageName: string, root: UiNode) {
  const pid = await runDeviceAdb(adbPath, serial, ["shell", "pidof", packageName]);
  const processId = pid.stdout.toString("utf8").trim().split(/\s+/)[0];
  if (pid.code !== 0 || !/^\d+$/.test(processId)) return 0;
  // Let registration return its allocated port even if cancellation arrives;
  // killing the client midway could leave an unknown ADB server-side forward.
  const forwarded = await inspectionContext.exit(() => runDeviceAdb(adbPath, serial, ["forward", "tcp:0", `jdwp:${processId}`]));
  const port = forwarded.stdout.toString("utf8").trim();
  if (forwarded.code !== 0 || !/^\d+$/.test(port)) return 0;
  try {
    let windowName = "";
    const layers = await captureViewLayers(Number(port), {
      rootRefs: root.children.map((node) => node.attributes?.["view-ref"]).filter((value): value is string => Boolean(value)),
      onHierarchy: (dump, name) => { applyViewProperties(root, dump, true); windowName = name; },
      signal: inspectionContext.getStore()?.signal,
    });
    // DDMS images use window coordinates; the restored tree uses screen coordinates.
    const windowBounds = root.children[0].bounds;
    let count = attachViewLayerImages(root, layers, { x: windowBounds?.left ?? 0, y: windowBounds?.top ?? 0 });
    const fallback: UiNode[] = [];
    const pending = [root];
    while (pending.length) {
      const node = pending.pop()!;
      if (!node.visibleToUser) continue;
      const bounds = node.bounds;
      if (node.attributes?.["view-ref"] && bounds && bounds.right > bounds.left && bounds.bottom > bounds.top && (bounds.right - bounds.left) * (bounds.bottom - bounds.top) <= 4_000_000 && bounds.right > 0 && bounds.bottom > 0 && bounds.left < (root.bounds?.right ?? Infinity) && bounds.top < (root.bounds?.bottom ?? Infinity)) fallback.push(node);
      pending.push(...node.children);
    }
    if (fallback.length) {
      try {
        fallback.sort((a, b) => Number(b.layerImageStatus === "ambiguous") - Number(a.layerImageStatus === "ambiguous"));
        const { images, failures, kinds } = await captureViewBitmaps(Number(port), { rootRef: root.children[0].attributes!["view-ref"], windowName }, fallback.map((node) => ({ ref: node.attributes!["view-ref"], captureOwn: !node.layerImageDataUrl && node.attributes!["skip-draw"] !== "true" })), inspectionContext.getStore()?.signal);
        if (failures.size) root.attributes = { ...root.attributes, "texture-capture-warning": `${failures.size} 个控件未完成独立画面补采，原因可在属性栏查看；已保留其余采集结果。` };
        for (const node of fallback) {
          const kind = kinds.get(node.attributes!["view-ref"]);
          if (kind === "surface") {
            // A View snapshot contains only the SurfaceView's placeholder/hole,
            // never its external buffer. Don't label that as a captured video.
            if (node.layerImageStatus === "captured") count--;
            delete node.layerImageDataUrl;
            delete node.layerImageSize;
            node.layerImageStatus = "failed";
            node.attributes!["image-source"] = "SurfaceView / OpenGL 独立缓冲层";
          }
          const failure = failures.get(node.attributes!["view-ref"]);
          if (failure) node.attributes!["image-capture-error"] = failure;
          const image = images.get(node.attributes!["view-ref"]);
          if (!image) continue;
          if (image.width !== node.bounds!.right - node.bounds!.left || image.height !== node.bounds!.bottom - node.bounds!.top) {
            node.attributes!["image-capture-error"] = "采集期间控件尺寸变化，请重新采集";
            continue;
          }
          if (node.layerImageStatus !== "captured") count++;
          node.layerImageDataUrl = image.pngDataUrl;
          node.layerImageSize = { width: image.width, height: image.height };
          node.layerImageStatus = "captured";
          node.attributes!["image-source"] = image.kind === "surface" ? "SurfaceView / OpenGL 独立缓冲层，不含父层或邻居" : image.kind === "texture" ? "TextureView 自身缓冲区" : "按对象身份独立采集，不含子节点";
        }
      } catch {
        inspectionContext.getStore()?.signal?.throwIfAborted();
        root.attributes = { ...root.attributes, "texture-capture-warning": "部分控件的独立画面补采失败，已保留此前采集结果。" };
      }
    }
    return count;
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

export function qmlUiTree(root: QmlDebugNode, packageName: string, viewport: UiBounds | null): UiNode {
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
    node.children = source.children.map((child, childIndex) => convert(child, `${id}/${childIndex}`, childIndex));
    return node;
  };
  return convert(root, "0", 0);
}

function delay(milliseconds: number) {
  return wait(milliseconds, undefined, { signal: inspectionContext.getStore()?.signal });
}

async function qmlDebugTree(adbPath: string, serial: string, target: ForegroundTarget) {
  const signal = inspectionContext.getStore()?.signal;
  signal?.throwIfAborted();
  const forward = await inspectionContext.exit(() => runDeviceAdb(adbPath, serial, ["forward", "tcp:0", `tcp:${QML_DEBUG_PORT}`]));
  if (forward.code !== 0) throw new Error(commandError("无法转发 QML 调试端口", forward));
  const port = Number(forward.stdout.toString("utf8").trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("QML 调试转发端口无效。");

  try {
    signal?.throwIfAborted();
    if (qmlDebugTargets.get(serial) === target.packageName) {
      try {
        return { root: await inspectQmlHierarchy(port, signal), restarted: false };
      } catch {
        signal?.throwIfAborted();
        qmlDebugTargets.delete(serial);
      }
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
        const root = await inspectQmlHierarchy(port, signal);
        qmlDebugTargets.set(serial, target.packageName);
        return { root, restarted: true };
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
    const target = foregroundTarget(activities.stdout.toString("utf8"));
    if (!target) return errorSnapshot(serial, "未找到正在前台运行的 Android App。");

    const debugCheck = await runDeviceAdb(adbPath, serial, ["shell", "run-as", target.packageName, "id"]);
    if (debugCheck.code !== 0) return errorSnapshot(serial, `仅支持 Debug App：${target.packageName} 不可调试。`);

    stage("读取控件树");
    const top = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", target.packageName]);
    if (top.code !== 0) return errorSnapshot(serial, commandError("无法读取 Debug App 层级", top));
    const section = targetActivitySection(top.stdout.toString("utf8"), target);
    const isQml = section.includes("org.qtproject.qt.android.");
    let root: UiNode;
    let inspectionSource: UiSnapshot["inspectionSource"];
    let warning: string | null = null;
    let rawHierarchy: string;

    if (isQml) {
      const qml = await qmlDebugTree(adbPath, serial, target);
      root = qmlUiTree(qml.root, target.packageName, appBounds(section));
      inspectionSource = "debug-qml";
      rawHierarchy = JSON.stringify(qml.root);
      if (qml.restarted) warning = "已重启目标 App 并建立 QML Debug 连接。";
    } else {
      root = debugViewTree(section, target);
      inspectionSource = "debug-view";
      rawHierarchy = section;
      stage("采集独立控件画面");
      try {
        const imageCount = await captureDebugViewImages(adbPath, serial, target.packageName, root);
        if (imageCount === 0) warning = "未读取到独立 View 画面，缺失画面的控件仅显示边框。";
        if (root.attributes?.["texture-capture-warning"]) warning = root.attributes["texture-capture-warning"];
      } catch (error) {
        options.signal?.throwIfAborted();
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
    const screenshot = await captureScreen(adbPath, serial);
    const after = await runDeviceAdb(adbPath, serial, ["shell", "dumpsys", "activity", "activities"]);
    if (after.code !== 0 || foregroundTarget(after.stdout.toString("utf8"))?.component !== target.component) {
      return errorSnapshot(serial, "采集期间前台窗口发生变化或无法校验，请保持页面稳定后重新采集。");
    }
    if (!screenshot.screenshotDataUrl) {
      warning = [warning, commandError("控件树已读取，但截图失败或不是有效 PNG", screenshot.result)].filter(Boolean).join(" ");
    } else if (screenshot.captureGeometry) {
      const integrity = assessCaptureGeometry(screenshot.captureGeometry);
      if (integrity.status === "mismatch") warning = [warning, integrity.message].filter(Boolean).join(" ");
    }

    stage("完成");
    return {
      serial,
      root,
      nodeCount: countNodes(root),
      xmlSize: Buffer.byteLength(rawHierarchy, "utf8"),
      rawXml: null,
      screenshotDataUrl: screenshot.screenshotDataUrl,
      error: null,
      warning,
      inspectionSource,
      captureTimings: timings,
      captureDurationMs: Math.round(performance.now() - started),
      ...(screenshot.captureGeometry ? { captureGeometry: screenshot.captureGeometry } : {}),
    };
  } catch (error) {
    options.signal?.throwIfAborted();
    return errorSnapshot(serial, error instanceof Error ? error.message : "读取 Debug 控件树失败。");
  }
}
