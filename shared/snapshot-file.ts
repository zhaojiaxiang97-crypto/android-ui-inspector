import { isUiSnapshot } from "./snapshot-validation";
import type { UiSnapshot } from "./types";

export const SNAPSHOT_FILE_FORMAT = "android-ui-inspector-snapshot";
export const SNAPSHOT_FILE_VERSION = 2;
export const MAX_SNAPSHOT_FILE_BYTES = 100 * 1024 * 1024;

export type ImportedSnapshotFile = { snapshot: UiSnapshot; legacy: boolean; exportedAt: string | null };
export type ImportSnapshotFileResult = { canceled: boolean; filePath: string | null; data: ImportedSnapshotFile | null; error: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function verifySnapshot(value: unknown, fileVersion = SNAPSHOT_FILE_VERSION): UiSnapshot {
  if (!isUiSnapshot(value) || !value.root) throw new Error("快照格式无效或没有控件树。");
  if (!Number.isSafeInteger(value.nodeCount) || !Number.isSafeInteger(value.xmlSize) || value.xmlSize < 0) throw new Error("快照节点数量或数据大小无效。");
  const ids = new Set<string>();
  const pending = [value.root];
  while (pending.length) {
    const node = pending.pop()!;
    if (!node.id || node.id.length > 512 || ids.has(node.id)) throw new Error("快照包含重复或无效的节点标识。");
    if (fileVersion === 1 && node.debugMetadata?.version === 2) throw new Error("快照文件 v1 不能包含 v2 业务信息，请使用完整 v2 文件。");
    ids.add(node.id);
    pending.push(...node.children);
  }
  if (ids.size !== value.nodeCount) throw new Error("快照节点数量与控件树不一致。");
  return value;
}

export function parseSnapshotFile(value: unknown): ImportedSnapshotFile {
  if (!isRecord(value)) throw new Error("请选择完整快照文件或旧版控件树 JSON。");
  if ("format" in value || "version" in value) {
    if (value.format !== SNAPSHOT_FILE_FORMAT) throw new Error("这不是 Android UI Inspector 快照文件。");
    if (value.version !== 1 && value.version !== SNAPSHOT_FILE_VERSION) throw new Error("快照文件版本不受支持，请使用兼容版本的应用。");
    if (typeof value.exportedAt !== "string" || value.exportedAt.length > 128 || !Number.isFinite(Date.parse(value.exportedAt))) throw new Error("快照导出时间无效。");
    return { snapshot: verifySnapshot(value.snapshot, value.version as number), legacy: false, exportedAt: value.exportedAt };
  }
  if (Object.keys(value).length !== 4 || !["serial", "root", "nodeCount", "xmlSize"].every(key => Object.prototype.hasOwnProperty.call(value, key)))
    throw new Error("请选择完整快照文件或旧版控件树 JSON。");
  const snapshot = verifySnapshot({ ...value, rawXml: null, screenshotDataUrl: null, error: null,
    warning: "旧版控件树 JSON 未保存整屏截图和完整采集信息。" });
  return { snapshot, legacy: true, exportedAt: null };
}

export function serializeSnapshotFile(snapshot: UiSnapshot, exportedAt = new Date().toISOString()) {
  verifySnapshot(snapshot);
  // Keep scalar-only exports readable by existing applications. A v2 payload must
  // carry the new file version so older readers reject it before loading values.
  const pending = snapshot.root ? [snapshot.root] : [];
  let version = 1;
  while (pending.length) {
    const node = pending.pop()!;
    if (node.debugMetadata?.version === 2) version = SNAPSHOT_FILE_VERSION;
    pending.push(...node.children);
  }
  const document = { format: SNAPSHOT_FILE_FORMAT, version, exportedAt, snapshot };
  parseSnapshotFile(document);
  const data = JSON.stringify(document, null, 2);
  if (new TextEncoder().encode(data).byteLength > MAX_SNAPSHOT_FILE_BYTES) throw new Error("完整快照超过 100 MiB，未导出。");
  return data;
}
