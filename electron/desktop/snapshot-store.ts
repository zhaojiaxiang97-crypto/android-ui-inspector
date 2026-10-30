import { app } from "electron";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SaveSnapshotRequest, SnapshotStoreResult, StoredSnapshot } from "../../shared/types";
import { isUiSnapshot } from "../../shared/snapshot-validation";
import { MAX_STORED_SNAPSHOTS, boundSnapshotHistory } from "./snapshot-retention";

const STORE_FILE_NAME = "snapshots.json";
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
    const file = await open(storePath(), constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    let content: string;
    let fileBytes = 0;
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error("本地快照路径不是普通文件。");
      fileBytes = info.size;
      if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
        if (typeof process.getuid === "function" && info.uid !== process.getuid())
          throw new Error("本地快照文件不属于当前用户。");
        // Old profiles could be 0644; secure the opened inode without rewriting its bytes.
        await file.chmod(0o600);
      }
      content = await file.readFile("utf8");
    } finally {
      await file.close();
    }
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed)) throw new Error("本地快照文件格式无效。");
    return { snapshots: parsed.filter(isStoredSnapshot).slice(-MAX_STORED_SNAPSHOTS), fileBytes };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { snapshots: [], fileBytes: 0 };
    if (isRecord(error) && error.code === "ELOOP") throw new Error("本地快照路径为符号链接，已拒绝读取。");
    throw error;
  }
}

async function writeStore(snapshots: StoredSnapshot[], serialized = JSON.stringify(snapshots, null, 2)) {
  const target = storePath();
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(join(app.getPath("userData")), { recursive: true });
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return Buffer.byteLength(serialized, "utf8");
}

function storeError(error: unknown): SnapshotStoreResult {
  return {
    snapshots: [],
    error: error instanceof Error ? error.message : "本地快照操作失败。",
  };
}

export async function loadSnapshots(): Promise<SnapshotStoreResult> {
  try {
    return { ...await withStoreLock(readStore), error: null };
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
      const { snapshots } = await readStore();
      const nextSnapshot: StoredSnapshot = {
        id: randomUUID(),
        capturedAt: input.capturedAt,
        savedAt: new Date().toISOString(),
        snapshot: input.snapshot,
      };
      const retained = boundSnapshotHistory([...snapshots, nextSnapshot]);
      const fileBytes = await writeStore(retained.snapshots, retained.serialized);
      return { snapshots: retained.snapshots, fileBytes, error: null };
    });
  } catch (error) {
    return storeError(error);
  }
}

export async function clearSnapshots(): Promise<SnapshotStoreResult> {
  try {
    return await withStoreLock(async () => {
      const fileBytes = await writeStore([]);
      return { snapshots: [], fileBytes, error: null };
    });
  } catch (error) {
    return storeError(error);
  }
}

export async function deleteSnapshot(id: unknown): Promise<SnapshotStoreResult> {
  if (typeof id !== "string" || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(id))
    return storeError(new Error("快照标识无效。"));
  try {
    return await withStoreLock(async () => {
      const { snapshots, fileBytes: currentBytes } = await readStore();
      if (!snapshots.some(snapshot => snapshot.id === id)) return { snapshots, fileBytes: currentBytes, error: "指定快照不存在。" };
      const remaining = snapshots.filter(snapshot => snapshot.id !== id);
      const fileBytes = await writeStore(remaining);
      return { snapshots: remaining, fileBytes, error: null };
    });
  } catch (error) {
    return storeError(error);
  }
}
