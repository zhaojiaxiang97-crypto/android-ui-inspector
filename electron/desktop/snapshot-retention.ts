import type { StoredSnapshot } from "../../shared/types";

export const MAX_STORED_SNAPSHOTS = 30;
export const MAX_SNAPSHOT_LIBRARY_BYTES = 200 * 1024 * 1024;

/** Keep the existing count policy; reaching the byte budget must never discard extra history. */
export function boundSnapshotHistory(snapshots: StoredSnapshot[], maxBytes = MAX_SNAPSHOT_LIBRARY_BYTES) {
  const retained = snapshots.slice(-MAX_STORED_SNAPSHOTS);
  const values: string[] = [];
  let bytes = 2; // JSON array brackets
  for (const item of retained) {
    const value = JSON.stringify(item);
    const next = Buffer.byteLength(value, "utf8") + (values.length ? 1 : 0);
    if (bytes + next > maxBytes)
      throw new Error("本地历史库已超过容量上限；请先导出或删除不需要的快照。本次保存未写入，原有历史不变。");
    values.push(value);
    bytes += next;
  }
  return { snapshots: retained, serialized: `[${values.join(",")}]` };
}
