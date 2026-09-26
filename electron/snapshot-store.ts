import { app } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SaveSnapshotRequest, SnapshotStoreResult, StoredSnapshot } from "../shared/types";
import { isUiSnapshot } from "../shared/snapshot-validation";

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
