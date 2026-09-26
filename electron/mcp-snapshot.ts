import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isUiSnapshot } from "../shared/snapshot-validation";
import type { UiSnapshot } from "../shared/types";

export const MAX_MCP_SNAPSHOT_BYTES = 50 * 1024 * 1024;
export type McpSnapshot = { id: string; sharedAt: string; ownerPid: number; selectedNodeId: string | null; snapshot: UiSnapshot };

export function publishMcpSnapshot(path: string, snapshot: unknown, selectedNodeId: unknown): McpSnapshot {
  if (!isUiSnapshot(snapshot) || !snapshot.root || snapshot.error) throw new Error("没有可共享的有效快照。");
  if (selectedNodeId !== null && (typeof selectedNodeId !== "string" || selectedNodeId.length > 2048)) throw new Error("选中节点无效。");
  const entry: McpSnapshot = { id: randomUUID(), sharedAt: new Date().toISOString(), ownerPid: process.pid, selectedNodeId, snapshot };
  writePrivateJson(path, entry);
  return entry;
}

export function writePrivateJson(path: string, value: unknown) {
  const data = JSON.stringify(value);
  if (Buffer.byteLength(data) > MAX_MCP_SNAPSHOT_BYTES) throw new Error("快照超过 50 MB，未共享。");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export function revokeMcpSnapshot(path: string) {
  rmSync(path, { force: true });
}

export function readMcpSnapshot(path: string): McpSnapshot {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_MCP_SNAPSHOT_BYTES) throw new Error("共享快照文件无效或超过 50 MB。");
    const value = JSON.parse(readFileSync(fd, "utf8")) as Partial<McpSnapshot> | null;
    if (!value || typeof value.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id) || typeof value.sharedAt !== "string"
      || !Number.isSafeInteger(value.ownerPid) || value.ownerPid! <= 0
      || (value.selectedNodeId !== null && typeof value.selectedNodeId !== "string")
      || !isUiSnapshot(value.snapshot) || !value.snapshot.root || value.snapshot.error) throw new Error("共享快照格式无效。");
    return value as McpSnapshot;
  } finally { closeSync(fd); }
}
