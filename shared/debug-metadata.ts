/** Explicit, read-only SDK values. Keep these limits aligned with DebugMetadata.java. */
export type DebugField = { key: string; label: string } & (
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
);
export type DebugGroup = { key: string; label: string; fields: DebugField[] };
export type DebugMetadata = { version: 1; source: "debug-sdk-explicit" } & (
  | { status: "captured"; groups: DebugGroup[] }
  | { status: "omitted-budget"; groups: [] }
);

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

/** The capture budget counts captured values; omission markers contain no business values. */
export function isDebugMetadata(value: unknown, budget = { bytes: 0 }): value is DebugMetadata {
  if (!record(value) || !keys(value, ["version", "source", "status", "groups"])
      || value.version !== 1 || value.source !== "debug-sdk-explicit" || !Array.isArray(value.groups)) return false;
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
      if (field.type === "string" ? !validString(field.value, 512)
          : field.type === "number" ? typeof field.value !== "number" || !Number.isFinite(field.value) || Math.abs(field.value) > Number.MAX_SAFE_INTEGER
          : field.type === "boolean" ? typeof field.value !== "boolean" : true) return false;
    }
  }
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > MAX_DEBUG_METADATA_NODE_BYTES || budget.bytes + bytes > MAX_DEBUG_METADATA_CAPTURE_BYTES) return false;
  budget.bytes += bytes;
  return true;
}

export const debugFieldTypeLabel = (type: DebugField["type"]) => ({ string: "文字", number: "数字", boolean: "布尔值" })[type];
export const debugFieldDisplayValue = (field: DebugField) => field.value === "" ? "（空字符串）" : String(field.value);
