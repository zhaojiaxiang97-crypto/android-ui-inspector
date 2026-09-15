import { app } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SaveSnapshotRequest, SnapshotStoreResult, StoredSnapshot, UiNode, UiSnapshot } from "../shared/types";
import { isCaptureGeometry } from "../shared/screen-coordinates";

const STORE_FILE_NAME = "snapshots.json";
const MAX_SNAPSHOTS = 30;
const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;

let storeQueue: Promise<void> = Promise.resolve();

function withStoreLock<T>(operation: () => Promise<T>) {
  const result = storeQueue.then(operation, operation);
  storeQueue = result.then(() => undefined, () => undefined);
  return result;
}

function storePath() {
  return join(app.getPath("userData"), STORE_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStringMap(value: unknown) {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isUiBounds(value: unknown) {
  if (!isRecord(value)) return false;
  return typeof value.left === "number"
    && typeof value.top === "number"
    && typeof value.right === "number"
    && typeof value.bottom === "number"
    && typeof value.raw === "string";
}

function isUiNode(value: unknown, depth = 0, budget = { count: 0 }): value is UiNode {
  if (!isRecord(value) || depth > 200 || budget.count++ > 20_000) return false;
  return typeof value.id === "string"
    && (value.index === null || typeof value.index === "number")
    && isNullableString(value.className)
    && isNullableString(value.package)
    && isNullableString(value.text)
    && isNullableString(value.resourceId)
    && isNullableString(value.contentDesc)
    && (value.bounds === null || isUiBounds(value.bounds))
    && typeof value.clickable === "boolean"
    && typeof value.enabled === "boolean"
    && typeof value.focusable === "boolean"
    && typeof value.focused === "boolean"
    && typeof value.scrollable === "boolean"
    && typeof value.selected === "boolean"
    && typeof value.visibleToUser === "boolean"
    && (value.layerImageDataUrl === undefined || typeof value.layerImageDataUrl === "string")
    && (value.layerImageSize === undefined || (isRecord(value.layerImageSize) && typeof value.layerImageSize.width === "number" && typeof value.layerImageSize.height === "number"))
    && (value.attributes === undefined || isStringMap(value.attributes))
    && Array.isArray(value.children)
    && value.children.every((child) => isUiNode(child, depth + 1, budget));
}

function isUiSnapshot(value: unknown): value is UiSnapshot {
  if (!isRecord(value)) return false;
  return typeof value.serial === "string"
    && value.serial.length <= 512
    && (value.root === null || isUiNode(value.root))
    && typeof value.nodeCount === "number"
    && Number.isFinite(value.nodeCount)
    && typeof value.xmlSize === "number"
    && Number.isFinite(value.xmlSize)
    && isNullableString(value.rawXml)
    && isNullableString(value.screenshotDataUrl)
    && isNullableString(value.error)
    && isNullableString(value.warning)
    && (value.inspectionSource === undefined || value.inspectionSource === "uiautomator" || value.inspectionSource === "debug-view" || value.inspectionSource === "debug-qml")
    && (value.hierarchyDumpMode === undefined || value.hierarchyDumpMode === "full" || value.hierarchyDumpMode === "compressed")
    && (value.captureGeometry === undefined || isCaptureGeometry(value.captureGeometry));
}

function isSaveSnapshotRequest(value: unknown): value is SaveSnapshotRequest {
  if (!isRecord(value)) return false;
  return typeof value.capturedAt === "string"
    && value.capturedAt.length <= 128
    && isUiSnapshot(value.snapshot);
}

function isStoredSnapshot(value: unknown): value is StoredSnapshot {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.capturedAt === "string"
    && typeof value.savedAt === "string"
    && isUiSnapshot(value.snapshot);
}

async function readStore() {
  try {
    const content = await readFile(storePath(), "utf8");
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed)) throw new Error("本地快照文件格式无效。");
    return parsed.filter(isStoredSnapshot).slice(-MAX_SNAPSHOTS);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeStore(snapshots: StoredSnapshot[]) {
  const target = storePath();
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(join(app.getPath("userData")), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(snapshots, null, 2), "utf8");
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function storeError(error: unknown): SnapshotStoreResult {
  return {
    snapshots: [],
    error: error instanceof Error ? error.message : "本地快照操作失败。",
  };
}

export async function loadSnapshots(): Promise<SnapshotStoreResult> {
  try {
    return { snapshots: await withStoreLock(readStore), error: null };
  } catch (error) {
    return storeError(error);
  }
}

export async function saveSnapshot(input: unknown): Promise<SnapshotStoreResult> {
  if (!isSaveSnapshotRequest(input)) {
    return storeError(new Error("快照数据格式无效。"));
  }

  let serializedSize = 0;
  try {
    serializedSize = Buffer.byteLength(JSON.stringify(input.snapshot), "utf8");
  } catch {
    return storeError(new Error("快照数据无法序列化。"));
  }
  if (serializedSize > MAX_SNAPSHOT_BYTES) {
    return storeError(new Error("快照过大，未写入本地文件。"));
  }

  try {
    return await withStoreLock(async () => {
      const snapshots = await readStore();
      const nextSnapshot: StoredSnapshot = {
        id: randomUUID(),
        capturedAt: input.capturedAt,
        savedAt: new Date().toISOString(),
        snapshot: input.snapshot,
      };
      const nextSnapshots = [...snapshots, nextSnapshot].slice(-MAX_SNAPSHOTS);
      await writeStore(nextSnapshots);
      return { snapshots: nextSnapshots, error: null };
    });
  } catch (error) {
    return storeError(error);
  }
}

export async function clearSnapshots(): Promise<SnapshotStoreResult> {
  try {
    return await withStoreLock(async () => {
      await writeStore([]);
      return { snapshots: [], error: null };
    });
  } catch (error) {
    return storeError(error);
  }
}
