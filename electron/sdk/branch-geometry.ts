/** Geometry-only transaction contract. Transport must validate pixels before supplying images. */
import { createHash } from "node:crypto";
export type BranchBinding = { packageName: string; pid: number; processInstance: string; rootRef: string; branchRef: string };
export type BranchGeometryRow = {
  ref: string; parent: string; x: number; y: number; width: number; height: number;
  visible: boolean; childCount: number; children: string[]; childRefsHash: string;
};
export type BranchGeometryRead = BranchBinding & { version: 1; nonce: string; started: number; ended: number;
  ancestors: BranchGeometryRow[]; nodes: BranchGeometryRow[] };
export type BranchImageGeometry = { x?: number; y?: number; width: number; height: number; structural?: boolean };
export type BranchRefreshDiagnostics = Readonly<{
  phase: "first-read" | "first-check" | "capture" | "verify-read" | "final-check" | "complete";
  firstReadMs?: number; captureMs?: number; verifyReadMs?: number; elapsedMs: number;
}>;
const identity = /^[\w.$]+@[0-9a-f]{1,8}$/;
const fail = (): never => { throw new Error("SDK 小分支几何身份、结构或预算无效"); };

export function parseBranchGeometry(data: string, nonce: string, binding: BranchBinding, path: readonly string[]): BranchGeometryRead {
  if (!/^[0-9a-f]{16}$/.test(nonce) || data.length > 64_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) fail();
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > 48_000 || bytes.toString("base64") !== data) fail();
  const value = JSON.parse(bytes.toString("utf8")) as BranchGeometryRead;
  if (!value || value.version !== 1 || value.nonce !== nonce
      || !Number.isSafeInteger(binding.pid) || binding.pid < 1 || !/^[0-9a-f-]{36}$/.test(binding.processInstance)
      || !binding.packageName || !identity.test(binding.rootRef) || !identity.test(binding.branchRef)
      || (Object.keys(binding) as (keyof BranchBinding)[]).some(k => value[k] !== binding[k])
      || path.length < 2 || path.length > 33 || new Set(path).size !== path.length
      || path.some(ref => ref.length > 256 || !identity.test(ref)) || path[0] !== binding.rootRef || path.at(-1) !== binding.branchRef
      || !Number.isSafeInteger(value.started) || value.started < 0 || !Number.isSafeInteger(value.ended)
      || value.ended < value.started || value.ended - value.started > 250
      || !Array.isArray(value.ancestors) || value.ancestors.length !== path.length - 1
      || !Array.isArray(value.nodes) || value.nodes.length < 1 || value.nodes.length > 64) fail();
  const rows = [...value.ancestors, ...value.nodes];
  const refs = new Set<string>(); let pixels = 0;
  for (const row of rows) {
    if (!row || typeof row.ref !== "string" || row.ref.length > 256 || !identity.test(row.ref) || refs.has(row.ref)
        || typeof row.parent !== "string" || row.parent.length > 256 || row.parent && !identity.test(row.parent)
        || ![row.x, row.y, row.width, row.height].every(Number.isSafeInteger)
        || Math.abs(row.x) > 100_000 || Math.abs(row.y) > 100_000 || row.width < 0 || row.width > 100_000 || row.height < 0 || row.height > 100_000
        || typeof row.visible !== "boolean" || !Number.isSafeInteger(row.childCount) || row.childCount < 0 || row.childCount > 5000
        || typeof row.childRefsHash !== "string" || !/^[a-f0-9]{64}$/.test(row.childRefsHash)
        || !Array.isArray(row.children) || row.children.length > 63 || row.children.some(ref => typeof ref !== "string" || !identity.test(ref))) fail();
    refs.add(row.ref);
  }
  for (let i = 0; i < value.ancestors.length; i++) {
    const row = value.ancestors[i];
    if (row.ref !== path[i] || row.children.length || i === 0 && row.parent !== "" || i > 0 && row.parent !== path[i - 1]
        || !row.visible || row.childCount < 1) fail();
  }
  if (value.nodes[0].ref !== binding.branchRef || value.nodes[0].parent !== path[path.length - 2]) fail();
  const expected = [binding.branchRef];
  const parent = new Map([[binding.branchRef, path[path.length - 2]]]);
  for (let i = 0; i < value.nodes.length; i++) {
    const row = value.nodes[i];
    if (row.ref !== expected[i] || row.parent !== parent.get(row.ref) || row.childCount !== row.children.length
        || row.childRefsHash !== createHash("sha256").update(row.children.join(";")).digest("hex")) fail();
    if (row.visible) pixels += row.width * row.height;
    if (pixels > 4_000_000 || expected.length + row.children.length > 64) fail();
    for (const child of row.children) {
      if (parent.has(child) || value.ancestors.some(a => a.ref === child)) fail();
      parent.set(child, row.ref); expected.push(child);
    }
  }
  if (expected.length !== value.nodes.length) fail();
  // Explicit projection: never carry unexpected pixel/property fields out of a geometry reply.
  const copy = (row: BranchGeometryRow): BranchGeometryRow => ({ ref: row.ref, parent: row.parent, x: row.x, y: row.y,
    width: row.width, height: row.height, visible: row.visible, childCount: row.childCount, children: [...row.children], childRefsHash: row.childRefsHash });
  return { ...binding, version: 1, nonce, started: value.started, ended: value.ended,
    ancestors: value.ancestors.map(copy), nodes: value.nodes.map(copy) };
}

function rowMismatch(a: BranchGeometryRow, b: BranchGeometryRow, stable: boolean): string | null {
  const fields = { ref: "对象身份", parent: "父节点身份", visible: "可见状态", childCount: "子项数量", childRefsHash: "子项身份或顺序" } as const;
  for (const key of Object.keys(fields) as (keyof typeof fields)[]) if (a[key] !== b[key]) return fields[key];
  if (a.children.length !== b.children.length || a.children.some((ref, i) => ref !== b.children[i])) return "子项身份或顺序";
  if (stable) {
    if (a.x !== b.x || a.y !== b.y) return "位置";
    if (a.width !== b.width || a.height !== b.height) return "尺寸";
  }
  return null;
}

/** One read → one capture → one verification. Returns a candidate, never mutates the old tree. */
export async function verifyBranchGeometryRefresh<T extends BranchImageGeometry>(original: BranchGeometryRead,
  read: () => Promise<BranchGeometryRead>, capture: (refs: string[]) => Promise<ReadonlyMap<string, T>>, signal?: AbortSignal,
  observe?: (diagnostics: BranchRefreshDiagnostics) => void
): Promise<{ geometry: BranchGeometryRead; images: ReadonlyMap<string, T> }> {
  const started = performance.now();
  const diagnostics: { -readonly [K in keyof BranchRefreshDiagnostics]: BranchRefreshDiagnostics[K] } = { phase: "first-read", elapsedMs: 0 };
  const timed = async <V>(key: "firstReadMs" | "captureMs" | "verifyReadMs", operation: () => Promise<V>): Promise<V> => {
    const began = performance.now();
    try { return await operation(); }
    finally { diagnostics[key] = Math.max(0, Math.round(performance.now() - began)); }
  };
  try {
    const check = () => signal?.throwIfAborted();
    check();
    const before = structuredClone(await timed("firstReadMs", read)); check();
    const compatible = (a: BranchGeometryRead, b: BranchGeometryRead, stable: boolean) => {
      const reject = (detail: string): never => {
        // Field names/indices only: do not leak private class names, references or pixels.
        throw new Error(`分支或祖先在刷新期间变化（${stable ? "补图后复读" : "首次复读"}：${detail}），保留原快照`);
      };
      if (["packageName", "pid", "processInstance", "rootRef", "branchRef"].some(k => a[k as keyof BranchBinding] !== b[k as keyof BranchBinding])) reject("进程、窗口或分支身份");
      if (a.ancestors.length !== b.ancestors.length) reject("祖先数量");
      if (a.nodes.length !== b.nodes.length) reject("分支节点数量");
      for (const [kind, rows, next, geometryStable] of [
        ["祖先", a.ancestors, b.ancestors, true], ["分支节点", a.nodes, b.nodes, stable],
      ] as const) for (let i = 0; i < rows.length; i++) {
        const mismatch = rowMismatch(rows[i], next[i], geometryStable);
        if (mismatch) reject(`${kind} #${i} 的${mismatch}`);
      }
    };
    diagnostics.phase = "first-check";
    compatible(original, before, false);
    const requested = before.nodes.filter(row => row.visible && row.width > 0 && row.height > 0);
    if (!requested.length || requested.length > 64 || requested.reduce((sum, row) => sum + row.width * row.height, 0) > 4_000_000)
      throw new Error("小分支刷新超过数量或像素预算");
    diagnostics.phase = "capture";
    const images = await timed("captureMs", () => capture(requested.map(row => row.ref))); check();
    diagnostics.phase = "verify-read";
    const after = structuredClone(await timed("verifyReadMs", read)); check();
    diagnostics.phase = "final-check";
    if (after.started < before.ended) throw new Error("小分支核对时间顺序无效");
    compatible(before, after, true);
    if (images.size !== requested.length || requested.some(row => {
      const image = images.get(row.ref);
      if (image?.structural === true) return false; // Explicit, authenticated SDK pure-layout result, not an inferred empty bitmap.
      return !image || !Number.isFinite(image.x) || !Number.isFinite(image.y)
        || Math.abs(image.x! - row.x) > 1 || Math.abs(image.y! - row.y) > 1
        || image.width !== row.width || image.height !== row.height;
    })) throw new Error("小分支画面缺失或几何失配，保留原快照");
    diagnostics.phase = "complete";
    return { geometry: after, images };
  } finally {
    diagnostics.elapsedMs = Math.max(0, Math.round(performance.now() - started));
    // Host timings only, not device UI/GPU timings. Observation cannot change acceptance.
    try { observe?.(Object.freeze({ ...diagnostics })); } catch { /* Diagnostic-only observer. */ }
  }
}
