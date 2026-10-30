import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import type { DisplayFrame } from "../../shared/types";
import { parseHelperObservationDiagnostics, type HelperObservationDiagnostics } from "../../shared/helper-observation-diagnostics";
import { assessHelperRecoveryEvidence, type HelperRecoveryEvidence } from "../../shared/helper-observation";
import { parseHelperRecoveryDiagnostics, type HelperRecoveryDiagnostics } from "../../shared/helper-recovery-diagnostics";
import { MAX_UI_HIERARCHY_DEPTH, parseUiHierarchy } from "./xml-tree";
import { withoutCommandSignal } from "../device/command-context";
import { runCommand } from "../device/runtime";
import { openOwnedDebugForward } from "../platform/owned-debug-forward";

const MAX_BYTES = 8 * 1024 * 1024;
function freezeEvidence<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freezeEvidence(item);
    Object.freeze(value);
  }
  return value;
}
export class HelperCaptureError extends Error {
  readonly diagnostics?: HelperObservationDiagnostics;
  readonly recoveryEvidence?: HelperRecoveryEvidence;
  readonly recoveryDiagnostics?: HelperRecoveryDiagnostics;
  constructor(readonly code: string, message: string,
    detail?: { diagnostics?: HelperObservationDiagnostics; recoveryEvidence?: HelperRecoveryEvidence; recoveryDiagnostics?: HelperRecoveryDiagnostics }) {
    super(message);
    this.diagnostics = freezeEvidence(parseHelperObservationDiagnostics(detail?.diagnostics));
    const proposed = detail?.recoveryEvidence;
    const assessment = code === "helper-incomplete" && proposed
      ? assessHelperRecoveryEvidence(proposed, proposed.packageName, proposed.displayAfter) : undefined;
    const candidate = assessment?.evidence;
    const sameDiagnostics = candidate && JSON.stringify(candidate.diagnostics) === JSON.stringify(this.diagnostics);
    this.recoveryEvidence = sameDiagnostics
      ? freezeEvidence(candidate) : undefined;
    const recoveryDiagnostics = parseHelperRecoveryDiagnostics(detail?.recoveryDiagnostics) ?? assessment?.diagnostics;
    this.recoveryDiagnostics = freezeEvidence(candidate && !sameDiagnostics
      ? { version: 1, ...recoveryDiagnostics, candidate: "diagnostics_mismatch" } : recoveryDiagnostics);
    Object.defineProperty(this, "diagnostics", { writable: false, configurable: false });
    Object.defineProperty(this, "recoveryEvidence", { writable: false, configurable: false });
    Object.defineProperty(this, "recoveryDiagnostics", { writable: false, configurable: false });
  }
}
function reject(code: string, message: string): never { throw new HelperCaptureError(code, message); }
const helperSchema = z.object({ success: z.literal(true), xml: z.string().min(1), truncated: z.literal(false),
  width: z.number().int().positive(), height: z.number().int().positive(), rotation: z.number().int().min(0).max(3),
  window_count: z.number().int().min(1).max(16), node_count: z.number().int().min(1).max(5000) });

export async function readHelperDump(port: number, token: string, signal: AbortSignal) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[A-Za-z0-9_-]{16,256}$/.test(token)) reject("helper-config", "Helper 端口或令牌格式无效");
  const response = await fetch(`http://127.0.0.1:${port}/dump?fields=xml`, {
    method: "GET", redirect: "error", headers: { "X-Artemis-Token": token }, signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    reject("helper-http", `Helper 返回 HTTP ${response.status}，未重试或重新配对`);
  }
  const reader = response.body?.getReader();
  if (!reader) reject("helper-empty", "Helper 响应为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > MAX_BYTES) reject("helper-size", "Helper 响应超过 8MiB");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  let data: unknown;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { reject("helper-format", "Helper 响应不是有效 JSON"); }
  if (data && typeof data === "object") {
    if ((data as Record<string, unknown>).success === false) reject("helper-empty", "Helper 未获得活动窗口或有效控件树");
    if ((data as Record<string, unknown>).truncated === true) reject("helper-truncated", "Helper 控件树被截断，不能用于完整比较");
  }
  const parsed = helperSchema.safeParse(data);
  if (!parsed.success) reject("helper-invalid", "Helper 为空树、截断树或协议字段无效");
  return parsed.data;
}

export function readHelperToken(path: string | undefined) {
  if (!path || !isAbsolute(path)) reject("helper-config", "请在桌面进程配置 ANDROID_UI_INSPECTOR_HELPER_TOKEN_FILE 私有令牌文件的绝对路径。");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 1024 || (info.mode & 0o077)
      || typeof process.getuid === "function" && info.uid !== process.getuid()) throw Error();
    const token = readFileSync(fd, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(token)) throw Error();
    return token;
  } catch { return reject("helper-config", "Helper 令牌文件须为≤1KiB、仅当前用户可读写的普通文件，内容须为有效会话令牌。"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function selectHelperHierarchy(dump: Awaited<ReturnType<typeof readHelperDump>>, packageName: string, frame: DisplayFrame) {
  if (dump.width !== frame.width || dump.height !== frame.height || dump.rotation !== frame.rotation)
    reject("geometry", "Helper 与主显示器方向或尺寸不一致。");
  if (Buffer.byteLength(dump.xml) > MAX_BYTES || /<!DOCTYPE|<!ENTITY/i.test(dump.xml) || XMLValidator.validate(dump.xml) !== true)
    reject("invalid-tree", "Helper 控件树为空、超限或格式无效。");
  const parser = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false, parseTagValue: false, trimValues: false,
    maxNestedTags: MAX_UI_HIERARCHY_DEPTH, isArray: name => name === "node" });
  const hierarchy = parser.parse(dump.xml).hierarchy;
  const roots: Record<string, unknown>[] = hierarchy?.node ?? [];
  if (hierarchy?.["@_rotation"] !== String(frame.rotation) || roots.length !== dump.window_count)
    reject("geometry", "Helper 窗口数量或XML方向与协议不一致。");
  const pending = [...roots];
  for (let i = 0; i < pending.length; i++) {
    if (pending.length > 5000) reject("tree-limit", "Helper 控件树超过5000节点上限。");
    pending.push(...(pending[i].node as Record<string, unknown>[] ?? []));
  }
  const focused = roots.filter(node => node["@_window-focused"] === "true");
  if (focused.length !== 1 || focused[0]["@_package"] !== packageName || focused[0]["@_window-type"] !== "application"
    || !/^\d+$/.test(String(focused[0]["@_window-id"]))) reject("window-mismatch", "Helper 未返回授权App的唯一焦点窗口。");
  const xml = new XMLBuilder({ ignoreAttributes: false, suppressBooleanAttributes: false })
    .build({ hierarchy: { "@_rotation": String(frame.rotation), node: focused[0] } });
  const parsed = parseUiHierarchy(xml);
  const nodes = [parsed.root];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.package !== packageName) reject("window-mismatch", "Helper 焦点树包含授权App以外的节点。");
    node.attributes = { ...node.attributes, "inspection-source": "accessibility-helper" };
    nodes.push(...node.children);
  }
  return { xml, root: parsed.root, nodeCount: nodes.length };
}

export async function readAccessibilityHelper(adbPath: string, serial: string, packageName: string, frame: DisplayFrame, signal: AbortSignal) {
  const token = readHelperToken(process.env.ANDROID_UI_INSPECTOR_HELPER_TOKEN_FILE);
  const forward = await openOwnedDebugForward(serial, "tcp:18888", signal, (args, timeout) => withoutCommandSignal(async () => {
    const result = await runCommand(adbPath, args, timeout);
    if (result.code !== 0) reject("helper-forward", "Helper 转发命令失败。");
    return result.stdout.toString("utf8");
  }));
  try { return selectHelperHierarchy(await readHelperDump(forward.port, token, signal), packageName, frame); }
  finally { await forward.close(); }
}
