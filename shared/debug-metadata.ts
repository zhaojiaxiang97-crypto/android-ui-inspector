/** Explicit, read-only SDK values. Keep these limits aligned with DebugMetadata.java. */
type DebugIdentity = { key: string; label: string };
export type DebugScalarValue =
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "null"; value: null };
export type DebugTreeNode = DebugIdentity & DebugScalarValue & { children: DebugTreeNode[] };
export type DebugField = DebugIdentity & (DebugScalarValue | { type: "tree"; value: DebugTreeNode[] });
export type DebugGroup = DebugIdentity & { fields: DebugField[] };
export type DebugMetadata = { version: 1 | 2; source: "debug-sdk-explicit" } & (
  | { status: "captured"; groups: DebugGroup[] }
  | { status: "omitted-budget"; groups: [] }
);

export const DEBUG_METADATA_VERSION = 2;
export const MAX_DEBUG_TREE_DEPTH = 8;
export const MAX_DEBUG_TREE_NODES = 128;
export const MAX_DEBUG_METADATA_NODE_BYTES = 16 * 1024;
export const MAX_DEBUG_METADATA_CAPTURE_BYTES = 256 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).length === allowed.length && allowed.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function validString(value: unknown, limit: number): value is string {
  if (typeof value !== "string" || value.length > limit) return false;
  // Reject unpaired surrogates so Java and desktop UTF-8 limits agree.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function identity(value: Record<string, unknown>) {
  return typeof value.key === "string" && /^[a-zA-Z][\w.-]{0,63}$/.test(value.key)
    && validString(value.label, 64) && value.label.length > 0
    && !/^[\x00-\x20]|[\x00-\x20]$|[\x00-\x1f\x7f]/.test(value.label);
}
function scalar(value: Record<string, unknown>, version: 1 | 2) {
  switch (value.type) {
    case "string": return validString(value.value, 512);
    case "number": return typeof value.value === "number" && Number.isFinite(value.value) && Math.abs(value.value) <= Number.MAX_SAFE_INTEGER;
    case "boolean": return typeof value.value === "boolean";
    case "null": return version === 2 && value.value === null;
    default: return false;
  }
}
function tree(nodes: unknown, depth: number, budget: { count: number }, active: Set<object>): boolean {
  if (!Array.isArray(nodes) || depth > MAX_DEBUG_TREE_DEPTH && nodes.length > 0 || nodes.length > MAX_DEBUG_TREE_NODES) return false;
  const siblings = new Set<string>();
  for (const node of nodes) {
    if (!record(node) || active.has(node) || ++budget.count > MAX_DEBUG_TREE_NODES
      || !keys(node, ["key", "label", "type", "value", "children"]) || !identity(node) || !scalar(node, 2)
      || siblings.has(node.key as string)) return false;
    siblings.add(node.key as string);
    active.add(node);
    if (!tree(node.children, depth + 1, budget, active)) return false;
    active.delete(node);
  }
  return true;
}

export const isDebugMetadataVersion = (value: unknown): value is 1 | 2 => value === 1 || value === 2;

/** The capture budget counts captured values; omission markers contain no business values. */
export function isDebugMetadata(value: unknown, budget = { bytes: 0 }): value is DebugMetadata {
  if (!record(value) || !keys(value, ["version", "source", "status", "groups"])
      || !isDebugMetadataVersion(value.version) || value.source !== "debug-sdk-explicit" || !Array.isArray(value.groups)) return false;
  if (value.status === "omitted-budget") return value.groups.length === 0;
  if (value.status !== "captured" || value.groups.length < 1 || value.groups.length > 4) return false;
  const groups = new Set<string>();
  for (const group of value.groups) {
    if (!record(group) || !keys(group, ["key", "label", "fields"]) || !identity(group)
        || groups.has(group.key as string) || !Array.isArray(group.fields) || group.fields.length < 1 || group.fields.length > 16) return false;
    groups.add(group.key as string);
    const fields = new Set<string>();
    for (const field of group.fields) {
      if (!record(field) || !keys(field, ["key", "label", "type", "value"]) || !identity(field) || fields.has(field.key as string)) return false;
      fields.add(field.key as string);
      if (field.type === "tree") {
        if (value.version !== 2 || !Array.isArray(field.value) || field.value.length < 1 || !tree(field.value, 1, { count: 0 }, new Set())) return false;
      } else if (!scalar(field, value.version)) return false;
    }
  }
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > MAX_DEBUG_METADATA_NODE_BYTES || budget.bytes + bytes > MAX_DEBUG_METADATA_CAPTURE_BYTES) return false;
  budget.bytes += bytes;
  return true;
}

export const debugFieldTypeLabel = (type: DebugField["type"]) => ({ string: "文字", number: "数字", boolean: "布尔值", null: "空值", tree: "分层信息" })[type];
/** Strings stay byte-for-byte text; other types use their complete JSON representation. */
export const debugFieldRawValue = (field: DebugField | DebugTreeNode) => field.type === "string" ? field.value : JSON.stringify(field.value);
export const debugFieldCopyValue = debugFieldRawValue;
export const debugFieldDisplayValue = (field: DebugField | DebugTreeNode) => field.type === "tree" ? `分层信息 · ${countDebugTreeNodes(field.value)} 项`
  : field.value === "" ? "（空字符串）" : field.value === null ? "null（空值）" : String(field.value);
export function countDebugTreeNodes(nodes: DebugTreeNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countDebugTreeNodes(node.children), 0);
}
/** Search only explicit data and real key paths, never String(object). */
export function debugFieldSearchValues(field: DebugField, parentPath = ""): string[] {
  const path = parentPath ? `${parentPath}/${field.key}` : field.key;
  const values = [path, field.key, field.label, field.type, debugFieldTypeLabel(field.type), debugFieldRawValue(field), debugFieldDisplayValue(field)];
  if (field.type === "tree") {
    const visit = (nodes: DebugTreeNode[], parent: string) => {
      for (const node of nodes) {
        const nodePath = `${parent}/${node.key}`;
        values.push(nodePath, node.key, node.label, node.type, debugFieldTypeLabel(node.type), debugFieldRawValue(node), debugFieldDisplayValue(node));
        if (node.value === "") values.push("空字符串 empty ∅");
        if (node.value === null) values.push("null 空值");
        visit(node.children, nodePath);
      }
    };
    visit(field.value, path);
  } else if (field.value === "") values.push("空字符串 empty ∅");
  return values;
}
