import { XMLParser } from "fast-xml-parser";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { AdbProbeResult, CaptureGeometry, DeviceInfo, HierarchyDumpMode, UiBounds, UiNode, UiSnapshot } from "../shared/types";
import { assessCaptureGeometry, isRotation } from "../shared/screen-coordinates";
import { parseInputDisplay, pngSize } from "./capture-display";

const COMMAND_TIMEOUT_MS = 30_000;
const UI_XML_PATH = "/sdcard/window_dump.xml";
const MAX_UI_HIERARCHY_DEPTH = 200;

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
    const child = spawn(command, args, { windowsHide: true });
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

  return { serial, state, model, product, transportId };
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

function countNodes(node: UiNode): number {
  let count = 0;
  const pending = [node];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    count += 1;
    pending.push(...pending[cursor].children);
  }
  return count;
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

    return {
      adbPath,
      adbVersion,
      devices: devicesResult.stdout
        .toString("utf8")
        .split(/\r?\n/)
        .map(parseDeviceLine)
        .filter((device): device is DeviceInfo => device !== null),
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

export async function inspectDevice(serial: string): Promise<UiSnapshot> {
  if (!serial.trim()) return errorSnapshot(serial, "设备序列号不能为空。");

  const adbPath = findAdbPath();
  if (!adbPath) return errorSnapshot(serial, "未找到 adb。请安装 Android SDK Platform-Tools 后重试。");

  try {
    let hierarchyDumpMode: HierarchyDumpMode = "full";
    // Full mode is the useful default for inspection. Compressed mode omits
    // nodes marked as not important by Android and is only a compatibility
    // fallback for vendor/older implementations that reject the full dump.
    let dumpResult = await runDeviceAdb(adbPath, serial, ["shell", "uiautomator", "dump", UI_XML_PATH]);
    if (dumpResult.code !== 0) {
      hierarchyDumpMode = "compressed";
      dumpResult = await runDeviceAdb(adbPath, serial, ["shell", "uiautomator", "dump", "--compressed", UI_XML_PATH]);
    }
    if (dumpResult.code !== 0) {
      return errorSnapshot(serial, commandError("无法导出 UI hierarchy", dumpResult));
    }

    let xmlResult = await runDeviceAdb(adbPath, serial, ["exec-out", "cat", UI_XML_PATH]);
    if (xmlResult.code !== 0) {
      // exec-out is preferred because it keeps XML bytes intact; shell is the fallback.
      xmlResult = await runDeviceAdb(adbPath, serial, ["shell", "cat", UI_XML_PATH]);
    }
    if (xmlResult.code !== 0) {
      return errorSnapshot(serial, commandError("无法读取 UI hierarchy XML", xmlResult));
    }

    const xml = xmlResult.stdout.toString("utf8");
    const { root, rotation } = parseUiHierarchy(xml);
    const nodeCount = countNodes(root);
    let screenshotDataUrl: string | null = null;
    let warning: string | null = hierarchyDumpMode === "compressed"
      ? "完整 UI hierarchy 获取失败，已回退到压缩模式，部分节点可能被省略。"
      : null;
    let captureGeometry: CaptureGeometry | undefined;

    const beforeScreenshot = await readDisplayFrame(adbPath, serial);
    const screenshotResult = await runDeviceAdb(adbPath, serial, ["exec-out", "screencap", "-p"]);
    const screenshotSize = pngSize(screenshotResult.stdout);
    if (screenshotResult.code === 0 && screenshotSize) {
      screenshotDataUrl = `data:image/png;base64,${screenshotResult.stdout.toString("base64")}`;
      const afterScreenshot = await readDisplayFrame(adbPath, serial);
      captureGeometry = { hierarchyRotation: rotation, beforeScreenshot, afterScreenshot, screenshotSize };
      const integrity = assessCaptureGeometry(captureGeometry);
      if (integrity.status === "mismatch") warning = integrity.message;
    } else {
      const screenshotWarning = commandError("UI hierarchy 已读取，但截图失败或不是有效 PNG", screenshotResult);
      warning = [warning, screenshotWarning].filter(Boolean).join(" ") || null;
    }

    return {
      serial,
      root,
      nodeCount,
      xmlSize: Buffer.byteLength(xml, "utf8"),
      rawXml: xml,
      screenshotDataUrl,
      error: null,
      warning,
      hierarchyDumpMode,
      ...(captureGeometry ? { captureGeometry } : {}),
    };
  } catch (error) {
    return errorSnapshot(serial, error instanceof Error ? error.message : "读取 UI hierarchy 失败。");
  }
}
