import type { UiNode } from "../../shared/types";
import { captureScreenQuad, rectangularCapturePlacement, validScreenMatrix } from "../../shared/capture-transform";
import { matchesViewRoot, type CapturedViewLayer } from "./view-protocol";
import { verifyBranchGeometryRefresh, type BranchGeometryRead, type BranchRefreshDiagnostics } from "../sdk/branch-geometry";
import { selectBranchRecovery, stageRecoveredBranch, commitRecoveredBranch, type BranchRecoverySelection } from "../sdk/branch-recovery";


function viewLayerName(node: UiNode) {
  if (node.attributes?.["debug-layer-name"]) return node.attributes["debug-layer-name"];
  if (node.resourceId?.includes(":id/")) return `id/${node.resourceId.split(":id/")[1]}`;
  const className = node.className ?? "";
  return className.slice(className.lastIndexOf(".") + 1);
}

// Exact framework classes only: a custom subclass may still own a Surface.
export const ordinaryViewClasses = new Set([
  "android.view.View", "android.view.ViewGroup", "android.widget.TextView", "android.widget.ImageView",
  "android.widget.FrameLayout", "android.widget.LinearLayout", "android.widget.RelativeLayout",
  "android.widget.Button", "android.widget.EditText", "android.widget.ImageButton",
  "android.widget.ProgressBar", "android.widget.ScrollView", "android.widget.HorizontalScrollView",
]);
export function needsViewBitmapFallback(node: UiNode, verifiedOwnBitmap = false, pureLayout = false) {
  if (pureLayout) return false;
  return node.layerImageStatus !== "captured" || node.attributes?.["skip-draw"] === "true" || !verifiedOwnBitmap && !ordinaryViewClasses.has(node.className ?? "") && !hasSdkOrdinaryViewType(node);
}

// The adopted SDK tree already binds this immutable class chain to the View ref.
// This only avoids type-only lookup for an image that DDMS has already matched;
// it never skips missing own images or identifies video from a class-name guess.
export function hasSdkOrdinaryViewType(node: UiNode): boolean {
  const attrs = node.attributes;
  if (!attrs || (attrs["tree-source"] !== "debug-sdk" && attrs["sdk-type-source"] !== "checked-tree") || !attrs["sdk-process-instance"] || !node.className
      || !attrs["view-ref"]?.startsWith(`${node.className}@`)
      || !/^[0-9a-f]{1,8}$/i.test(attrs["view-ref"].slice(node.className.length + 1))) return false;
  const chain = attrs["sdk-class-hierarchy"]?.split(" → ");
  return Boolean(chain && chain.length >= 1 && chain.length <= 24 && chain[0] === node.className
    && chain.at(-1) === "android.view.View" && new Set(chain).size === chain.length
    && chain.every(name => /^[\w.$]{1,512}$/.test(name))
    && !chain.includes("android.view.SurfaceView") && !chain.includes("android.view.TextureView"));
}

/** Copy only type evidence from the identity/geometry-verified join, not its tree or images. */
export function applyVerifiedSdkViewTypes(root: UiNode, verified: UiNode): void {
  const types = new Map<string, UiNode>();
  const pending = [verified];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.attributes?.["tree-source"] === "debug-sdk" && node.attributes["view-ref"]) types.set(node.attributes["view-ref"], node);
    pending.push(...node.children);
  }
  pending.push(root);
  while (pending.length) {
    const node = pending.pop()!;
    const donor = types.get(node.attributes?.["view-ref"] ?? "");
    if (donor?.className === node.className && donor?.attributes?.["sdk-class-hierarchy"] && donor.attributes["sdk-process-instance"]) {
      node.attributes = { ...node.attributes, "sdk-type-source": "checked-tree",
        "sdk-class-hierarchy": donor.attributes["sdk-class-hierarchy"], "sdk-process-instance": donor.attributes["sdk-process-instance"] };
    }
    pending.push(...node.children);
  }
}

export function layerCaptureFailureWarning(root: UiNode): string | null {
  let failed = 0;
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.layerImageStatus === "failed") failed++;
    pending.push(...node.children);
  }
  return failed ? `${failed} 个控件未取得独立画面，原因可在属性栏查看；已保留其余采集结果。` : null;
}

export type CaptureGeometryEvidence = { diagnosticOnly?: boolean; ref: string; rootRef: string; started: number; ended: number; rootReached: boolean; chain: unknown[][]; bitmapSpace?: "view-local"; localToScreen?: number[];
  clipContext?: { ref: string; clipBounds: number[] | null; padding: number[]; localToScreen?: number[] }[] };
export type FallbackLayerImage = { width: number; height: number; x?: number; y?: number; imageDataUrl: string; kind: "own" | "texture" | "surface"; empty: boolean; geometry?: CaptureGeometryEvidence };

/** Optional Debug SDK diagnostics, bound to the already authenticated request/root and requested objects. */
export function parseCaptureGeometryEvidence(value: string | undefined, refs: readonly string[], rootRef: string): Map<string, CaptureGeometryEvidence> {
  if (value === undefined) return new Map(); // Old SDKs ignore the optional request flag.
  const invalid = () => new Error("SDK 绘制父链证据无效");
  if (value.length > 64_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw invalid();
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > 48_000 || bytes.toString("base64") !== value) throw invalid();
  let records: unknown;
  try { records = JSON.parse(bytes.toString("utf8")); } catch { throw invalid(); }
  if (!Array.isArray(records) || records.length > 8 || records.length > refs.length) throw invalid();
  const result = new Map<string, CaptureGeometryEvidence>();
  const validRef = (ref: unknown) => typeof ref === "string" && ref.length <= 256 && /^[\w.$]+@[0-9a-f]{1,8}$/i.test(ref);
  for (const record of records) {
    const r = record as CaptureGeometryEvidence;
    if (!r || !validRef(r.ref) || !refs.includes(r.ref) || result.has(r.ref) || r.rootRef !== rootRef
      || r.diagnosticOnly !== undefined && r.diagnosticOnly !== true
      || r.diagnosticOnly === true && (r.chain?.length > 2 || r.bitmapSpace !== undefined || r.localToScreen !== undefined || r.clipContext !== undefined)
      || !Number.isSafeInteger(r.started) || !Number.isSafeInteger(r.ended) || r.started < 0 || r.ended < r.started || r.ended - r.started > 3_000
      || typeof r.rootReached !== "boolean" || !Array.isArray(r.chain) || r.chain.length < 1 || r.chain.length > 9) throw invalid();
    const seen = new Set<string>();
    for (let i = 0; i < r.chain.length; i++) {
      const row = r.chain[i];
      if (!Array.isArray(row) || row.length !== 14 || !validRef(row[0]) || seen.has(row[0] as string)
        || !(row[1] === "" || validRef(row[1]))
        || !row.slice(2, 8).every(v => typeof v === "number" && Number.isSafeInteger(v) && Math.abs(v) <= 2_147_483_647)
        || (row[4] as number) < 0 || (row[5] as number) < 0
        || typeof row[8] !== "number" || !Number.isFinite(row[8]) || row[8] < 0 || row[8] > 1
        || ![0, 4, 8].includes(row[9] as number)
        || !Array.isArray(row[10]) || row[10].length !== 9 || !row[10].every(v => typeof v === "number" && Number.isFinite(v))
        || !row.slice(11).every(v => typeof v === "boolean")
        || i < r.chain.length - 1 && row[1] !== r.chain[i + 1]?.[0]) throw invalid();
      seen.add(row[0] as string);
    }
    if (r.chain[0][0] !== r.ref || r.rootReached !== (r.chain.at(-1)![0] === rootRef)
      || r.chain.slice(0, -1).some(row => row[0] === rootRef)) throw invalid();
    if (r.localToScreen !== undefined || r.bitmapSpace !== undefined) {
      if (r.bitmapSpace !== "view-local" || !validScreenMatrix(r.localToScreen)) throw invalid();
      const quad = captureScreenQuad(r.localToScreen, r.chain[0][4] as number, r.chain[0][5] as number);
      if (!quad || Math.abs(quad[0].x - (r.chain[0][2] as number)) > 1
        || Math.abs(quad[0].y - (r.chain[0][3] as number)) > 1) throw invalid();
    }
    if (r.clipContext !== undefined) {
      const ints = (v: unknown): v is number[] => Array.isArray(v) && v.length === 4
        && v.every(n => typeof n === "number" && Number.isSafeInteger(n) && Math.abs(n) <= 2_147_483_647);
      if (!Array.isArray(r.clipContext) || r.clipContext.length !== r.chain.length) throw invalid();
      for (let i = 0; i < r.clipContext.length; i++) {
        const clip = r.clipContext[i];
        if (!clip || clip.ref !== r.chain[i][0] || !ints(clip.padding) || clip.padding.some(n => n < 0)
          || !(clip.clipBounds === null || ints(clip.clipBounds) && clip.clipBounds[2] >= clip.clipBounds[0] && clip.clipBounds[3] >= clip.clipBounds[1])
          || clip.localToScreen !== undefined && !validScreenMatrix(clip.localToScreen)) throw invalid();
      }
      if (r.localToScreen && JSON.stringify(r.clipContext[0].localToScreen) !== JSON.stringify(r.localToScreen)) throw invalid();
    }
    result.set(r.ref, r);
  }
  return result;
}

const geometryEvidenceKeys = ["image-capture-geometry-kind", "image-capture-position-delta", "image-capture-ancestor-evidence", "image-capture-evidence-phase", "image-capture-initial-geometry", "image-capture-parent-context"] as const;

export function parseCaptureGeometryFile(bytes: Buffer, nonce: string, instance: string, rootRef: string, layers: readonly CapturedViewLayer[]) {
  if (bytes.length > 4_000_000) throw new Error("SDK 几何文件超出预算");
  const envelope = JSON.parse(bytes.toString("utf8"));
  if (envelope?.version !== 1 || envelope.nonce !== nonce || envelope.processInstance !== instance || envelope.rootRef !== rootRef
    || !Array.isArray(envelope.records) || envelope.records.length > layers.length || layers.length > 5000) throw new Error("SDK 几何文件身份无效");
  const byRef = new Map(layers.map(layer => [layer.name, layer]));
  if (byRef.size !== layers.length) throw new Error("SDK 几何图片身份重复");
  const result = new Map<string, CaptureGeometryEvidence>();
  for (let offset = 0; offset < envelope.records.length; offset += 8) {
    const batch = envelope.records.slice(offset, offset + 8);
    const parsed = parseCaptureGeometryEvidence(Buffer.from(JSON.stringify(batch)).toString("base64"), [...byRef.keys()], rootRef);
    for (const [ref, evidence] of parsed) {
      const layer = byRef.get(ref)!;
      if (result.has(ref) || evidence.chain[0][2] !== layer.x || evidence.chain[0][3] !== layer.y
        || evidence.chain[0][4] !== layer.width || evidence.chain[0][5] !== layer.height) throw new Error("SDK 几何与图片不一致");
      result.set(ref, evidence);
    }
  }
  return result;
}

export function applyCapturePlacement(node: UiNode, geometry: CaptureGeometryEvidence | undefined, width: number, height: number) {
  node.attributes ??= {};
  delete node.layerCapturePlacement;
  delete node.attributes["image-capture-placement"];
  if (!geometry) return;
  const placement = rectangularCapturePlacement(geometry, width, height);
  if (placement) node.layerCapturePlacement = placement;
  node.attributes["image-capture-placement"] = placement ? "verified-rectangle" : "unsupported-context-legacy-fallback";
}

/** Compare only records from this batch. Matching deltas are evidence, not proof of causation or a shared frame. */
export function annotateFallbackGeometry(root: UiNode, images: ReadonlyMap<string, FallbackLayerImage>, phase = "initial"): void {
  const treeRefs = new Map<string, UiNode | null>();
  const parents = new Map<UiNode, string>();
  const tree = [root];
  while (tree.length) {
    const node = tree.pop()!;
    const ref = node.attributes?.["view-ref"];
    if (ref) treeRefs.set(ref, treeRefs.has(ref) ? null : node);
    for (const child of node.children) { parents.set(child, ref ?? ""); tree.push(child); }
  }
  const pending: { node: UiNode; ancestor?: { ref: string; dx: number; dy: number } }[] = [{ node: root }];
  while (pending.length) {
    const { node, ancestor } = pending.pop()!;
    const ref = node.attributes?.["view-ref"];
    const image = ref ? images.get(ref) : undefined;
    const b = node.bounds;
    const complete = image && b && Number.isFinite(image.x) && Number.isFinite(image.y)
      && image.width === b.right - b.left && image.height === b.bottom - b.top;
    const current = complete ? { ref: ref!, dx: image.x! - b.left, dy: image.y! - b.top } : undefined;
    if (image && node.attributes?.["image-capture-error"]) {
      node.attributes["image-capture-evidence-phase"] = phase;
      if (current) {
        node.attributes["image-capture-position-delta"] = `${current.dx},${current.dy}`;
        node.attributes["image-capture-ancestor-evidence"] = ancestor
          ? `${ancestor.ref}: ${ancestor.dx},${ancestor.dy}（同批记录，非同帧）`
          : "本批无可用祖先几何，移动来源未知";
        if (image.geometry) {
          const first = image.geometry.chain[0];
          const parent = image.geometry.chain.slice(1).find(row => treeRefs.get(row[0] as string)?.bounds);
          const p = parent ? treeRefs.get(parent[0] as string)!.bounds! : null;
          node.attributes["image-capture-ancestor-evidence"] = parents.get(node) !== first[1]
            ? "绘制时直接父对象与树不一致，禁止据此更新位置"
            : parent && p ? `${parent[0]}: ${(parent[2] as number) - p.left},${(parent[3] as number) - p.top}（同绘制任务父链对照；树仍来自更早时刻）`
              : "已记录同绘制任务父链，但旧树无唯一对应祖先，来源未知";
        }
      }
      if (phase === "initial") node.attributes["image-capture-initial-geometry"] = JSON.stringify({
        kind: node.attributes["image-capture-geometry-kind"], position: node.attributes["image-capture-actual-position"],
        size: node.attributes["image-capture-actual-size"], delta: node.attributes["image-capture-position-delta"],
        ancestor: node.attributes["image-capture-ancestor-evidence"],
        parentContext: node.attributes["image-capture-parent-context"],
      });
    }
    for (const child of node.children) pending.push({ node: child, ancestor: current ?? ancestor });
  }
}

export function applyFallbackLayerImage(node: UiNode, image: FallbackLayerImage): boolean {
  node.attributes ??= {};
  for (const key of geometryEvidenceKeys) delete node.attributes[key];
  if (image.geometry) node.attributes["image-capture-parent-context"] = JSON.stringify(image.geometry);
  const bounds = node.bounds;
  const incompletePosition = (image.x !== undefined || image.y !== undefined)
    && (!Number.isFinite(image.x) || !Number.isFinite(image.y));
  const moved = bounds && (image.x !== undefined || image.y !== undefined)
    && (incompletePosition || Math.abs(image.x! - bounds.left) > 1 || Math.abs(image.y! - bounds.top) > 1);
  if (!bounds || image.width !== bounds.right - bounds.left || image.height !== bounds.bottom - bounds.top || moved || incompletePosition) {
    node.attributes["image-capture-geometry-kind"] = !bounds ? "missing-tree-bounds" : incompletePosition ? "invalid-image-position"
      : image.width !== bounds.right - bounds.left || image.height !== bounds.bottom - bounds.top ? "size-mismatch" : "position-mismatch";
    node.attributes["image-capture-error"] = moved ? "采集期间控件位置变化，请重新采集" : "采集期间控件尺寸变化，请重新采集";
    node.attributes["image-capture-expected-size"] = bounds ? `${bounds.right - bounds.left}x${bounds.bottom - bounds.top}` : "未知";
    node.attributes["image-capture-actual-size"] = `${image.width}x${image.height}`;
    if (image.x !== undefined || image.y !== undefined) {
      node.attributes["image-capture-expected-position"] = bounds ? `${bounds.left},${bounds.top}` : "未知";
      node.attributes["image-capture-actual-position"] = `${image.x ?? "未知"},${image.y ?? "未知"}`;
    }
    if (!node.layerImageDataUrl) node.layerImageStatus = "failed";
    return false;
  }
  node.layerImageDataUrl = image.imageDataUrl;
  delete node.attributes["image-capture-source"];
  node.layerImageSize = { width: image.width, height: image.height };
  delete node.layerCapturePlacement;
  if (image.kind === "own" && image.geometry) {
    const placement = rectangularCapturePlacement(image.geometry, image.width, image.height);
    if (placement) node.layerCapturePlacement = placement;
    node.attributes["image-capture-placement"] = placement ? "verified-rectangle" : "unsupported-context-legacy-fallback";
  } else delete node.attributes["image-capture-placement"];
  node.layerImageStatus = "captured";
  node.layerImageEmpty = image.empty;
  delete node.attributes["image-capture-error"];
  delete node.attributes["image-capture-expected-size"];
  delete node.attributes["image-capture-actual-size"];
  delete node.attributes["image-capture-expected-position"];
  delete node.attributes["image-capture-actual-position"];
  delete node.attributes["image-capture-parent-context"];
  node.attributes["image-source"] = image.kind === "surface" ? "SurfaceView / OpenGL 独立缓冲层，不含父层或邻居" : image.kind === "texture" ? "TextureView 自身缓冲区" : "按对象身份独立采集，不含子节点";
  return true;
}

/** One small retry only; a moving page must not turn partial recovery into another full capture. */
export async function retryFallbackGeometry(nodes: readonly UiNode[], capture: (refs: string[]) => Promise<ReadonlyMap<string, FallbackLayerImage>>, root?: UiNode): Promise<{ requested: number; recovered: number }> {
  const candidates = nodes.filter(node => node.layerImageStatus === "failed" && !node.layerImageDataUrl
    && Boolean(node.attributes?.["view-ref"])
    && node.bounds && node.bounds.right > node.bounds.left && node.bounds.bottom > node.bounds.top
    && /^采集期间控件(?:位置|尺寸)变化，请重新采集$/.test(node.attributes?.["image-capture-error"] ?? ""));
  const pixels = candidates.reduce((sum, node) => sum + (node.bounds ? (node.bounds.right - node.bounds.left) * (node.bounds.bottom - node.bounds.top) : Infinity), 0);
  if (!candidates.length || candidates.length > 8 || pixels > 4_000_000) return { requested: 0, recovered: 0 };
  const images = await capture(candidates.map(node => node.attributes!["view-ref"]));
  let recovered = 0;
  for (const node of candidates) {
    const image = images.get(node.attributes!["view-ref"]);
    const initialEvidence = node.attributes!["image-capture-initial-geometry"];
    if (image && Number.isFinite(image.x) && Number.isFinite(image.y) && applyFallbackLayerImage(node, image)) recovered++;
    if (node.attributes!["image-capture-error"] && initialEvidence) node.attributes!["image-capture-initial-geometry"] = initialEvidence;
  }
  if (root) annotateFallbackGeometry(root, images, "retry");
  return { requested: candidates.length, recovered };
}

/** Strictly bounded recovery of one whole moved branch; image decoding/authentication remains in the existing SDK adapter. */
export type BranchRecoveryDiagnostics = Readonly<{
  phase: "selection" | "window-before" | "geometry" | "window-after" | "stage" | "commit" | "committed" | "skipped";
  selectionMs?: number; windowBeforeMs?: number; geometryMs?: number; windowAfterMs?: number;
  stageMs?: number; commitMs?: number; totalMs: number; geometry?: BranchRefreshDiagnostics;
}>;
export async function recoverSdkGeometryBranch(root: UiNode, candidates: readonly UiNode[],
  read: (path: readonly string[], branchRef: string) => Promise<BranchGeometryRead>,
  capture: (refs: string[]) => Promise<{ images: ReadonlyMap<string, FallbackLayerImage>; skipDraw: ReadonlySet<string>; failures: ReadonlyMap<string, string> }>,
  confirmWindow: () => Promise<void>, signal?: AbortSignal,
  onSelection?: (selection: BranchRecoverySelection, candidates: number) => void,
  observe?: (diagnostics: BranchRecoveryDiagnostics) => void): Promise<{ requested: number; recovered: number; countDelta: number }> {
  const started = performance.now();
  const diagnostics: { -readonly [K in keyof BranchRecoveryDiagnostics]: BranchRecoveryDiagnostics[K] } = { phase: "selection", totalMs: 0 };
  const elapsed = (since: number) => Math.max(0, Math.round(performance.now() - since));
  let synchronousAt = started;
  try {
    signal?.throwIfAborted();
    const selectedAt = performance.now();
    const failed = candidates.filter(node => node.layerImageStatus === "failed" && !node.layerImageDataUrl
      && /^采集期间控件(?:位置|尺寸)变化，请重新采集$/.test(node.attributes?.["image-capture-error"] ?? ""));
    const selection = selectBranchRecovery(root, failed, { packageName: root.package ?? "", pid: Number(root.attributes?.["debug-process-id"]),
      processInstance: root.attributes?.["sdk-visible-process-instance"] ?? "", rootRef: root.children[0]?.attributes?.["view-ref"] ?? "" });
    const plan = selection.plan;
    diagnostics.selectionMs = elapsed(selectedAt);
    onSelection?.(selection, failed.length);
    if (!plan) { diagnostics.phase = "skipped"; return { requested: 0, recovered: 0, countDelta: 0 }; }
    diagnostics.phase = "window-before";
    const windowBeforeAt = performance.now();
    try { await confirmWindow(); signal?.throwIfAborted(); }
    finally { diagnostics.windowBeforeMs = elapsed(windowBeforeAt); }
    type Image = FallbackLayerImage | { structural: true; width: number; height: number };
    let requested = 0;
    diagnostics.phase = "geometry";
    const geometryAt = performance.now();
    let result: Awaited<ReturnType<typeof verifyBranchGeometryRefresh<Image>>>;
    try {
      result = await verifyBranchGeometryRefresh<Image>(plan.original,
      () => read(plan.path, plan.original.branchRef), async refs => {
        requested = refs.length;
        const outcome = await capture(refs);
        if (outcome.failures.size) throw new Error("小分支补图未完整成功，保留原快照");
        const images = new Map<string, Image>(outcome.images);
        for (const ref of outcome.skipDraw) {
          if (images.has(ref)) throw new Error("SDK 结构容器与图片结果冲突");
          images.set(ref, { structural: true, width: 0, height: 0 });
        }
        return images;
      }, signal, geometry => { diagnostics.geometry = geometry; });
    } finally { diagnostics.geometryMs = elapsed(geometryAt); }
    diagnostics.phase = "window-after";
    const windowAfterAt = performance.now();
    try { await confirmWindow(); signal?.throwIfAborted(); }
    finally { diagnostics.windowAfterMs = elapsed(windowAfterAt); }
    diagnostics.phase = "stage";
    const stageAt = performance.now();
    synchronousAt = stageAt;
    const candidate = stageRecoveredBranch(plan, result.geometry, result.images, (node, image) => {
      if ("structural" in image && image.structural) {
        node.attributes = { ...node.attributes, "skip-draw": "true", "image-source": "SDK 已确认纯结构容器，无自身画面" };
        node.layerImageStatus = "unavailable"; return true;
      }
      delete node.attributes!["skip-draw"];
      return applyFallbackLayerImage(node, image as FallbackLayerImage);
    });
    const capturedCount = (branch: UiNode) => {
      const nodes = [branch]; let count = 0;
      for (let i = 0; i < nodes.length; i++) { if (nodes[i].layerImageStatus === "captured") count++; nodes.push(...nodes[i].children); }
      return count;
    };
    const countDelta = capturedCount(candidate) - capturedCount(plan.branch);
    diagnostics.stageMs = elapsed(stageAt);
    diagnostics.phase = "commit";
    const commitAt = performance.now();
    synchronousAt = commitAt;
    commitRecoveredBranch(plan, candidate, signal);
    diagnostics.commitMs = elapsed(commitAt);
    diagnostics.phase = "committed";
    return { requested, recovered: selection.failed.length, countDelta };
  } finally {
    if (diagnostics.phase === "stage") diagnostics.stageMs = elapsed(synchronousAt);
    if (diagnostics.phase === "commit") diagnostics.commitMs = elapsed(synchronousAt);
    diagnostics.totalMs = elapsed(started);
    // Scalar host diagnostics only. Reporting must never override success/failure/cancellation.
    try { observe?.(Object.freeze({ ...diagnostics })); } catch { /* Diagnostic-only observer. */ }
  }
}

export function attachViewLayerImages(root: UiNode, layers: readonly CapturedViewLayer[], windowOrigin = { x: 0, y: 0 }, imageSource: "sdk" | "ddms" | "unknown" = "unknown") {
  const nodes: UiNode[] = [];
  const stack = [...root.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    nodes.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]);
  }

  // DDMS CAPTURE_LAYERS has no identity for most records. Never resolve a
  // same-name/same-bounds collision by traversal order: it can swap pixels.
  const key = (name: string, x: number, y: number, width: number, height: number) => JSON.stringify([name, x, y, width, height]);
  const candidates = new Map<string, UiNode[]>();
  for (const node of nodes) {
    delete node.layerImageDataUrl;
    if (node.attributes) delete node.attributes["image-capture-source"];
    delete node.layerCapturePlacement;
    delete node.layerImageSize;
    delete node.layerImageEmpty;
    node.layerImageStatus = node.visibleToUser ? "unavailable" : "hidden";
    if (!node.visibleToUser || !node.bounds) continue;
    const { left, top, right, bottom } = node.bounds;
    // Android omits PFLAG_SKIP_DRAW views from anonymous CAPTURE_LAYERS.
    // Keep explicit identities usable; Surface/Texture buffers are captured separately.
    const names = [node.attributes?.["view-ref"]];
    if (node.attributes?.["skip-draw"] !== "true") names.push(viewLayerName(node));
    for (const name of new Set(names.filter((value): value is string => Boolean(value)))) {
      const id = key(name, left, top, right - left, bottom - top);
      candidates.set(id, [...(candidates.get(id) ?? []), node]);
    }
  }
  const counts = new Map<string, number>();
  for (const layer of layers) {
    if (!layer.visible || !layer.imageDataUrl || layer.width < 1 || layer.height < 1) continue;
    const id = key(layer.viewRef ?? layer.name, layer.x + windowOrigin.x, layer.y + windowOrigin.y, layer.width, layer.height);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let attached = 0;
  for (const layer of layers) {
    if (!layer.visible || !layer.imageDataUrl || layer.width < 1 || layer.height < 1) continue;
    const id = key(layer.viewRef ?? layer.name, layer.x + windowOrigin.x, layer.y + windowOrigin.y, layer.width, layer.height);
    const matches = candidates.get(id) ?? [];
    if (matches.length !== 1 || counts.get(id) !== 1) {
      for (const node of matches) if (node.layerImageStatus !== "captured") node.layerImageStatus = "ambiguous";
      continue;
    }
    const node = matches[0];
    if (node.layerImageStatus === "captured") continue;
    node.layerImageDataUrl = layer.imageDataUrl;
    node.attributes = { ...node.attributes, "image-capture-source": imageSource,
      "image-source": imageSource === "sdk" ? "SDK 独立图，不含子节点" : imageSource === "ddms" ? "DDMS 批量独立图，不含子节点" : "独立图，采集通道未记录" };
    applyCapturePlacement(node, layer.geometry, layer.width, layer.height);
    node.layerImageSize = { width: layer.width, height: layer.height };
    node.layerImageStatus = "captured";
    attached += 1;
  }
  // Android rounds getLocationInWindow and getLocationOnScreen separately.
  // Accept a one-pixel drift only when both the View and bitmap are unique.
  const nearbyKeys = (name: string, x: number, y: number, width: number, height: number) => {
    const keys: string[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) keys.push(key(name, x + dx, y + dy, width, height));
    return keys;
  };
  for (const layer of layers) {
    if (!layer.visible || !layer.imageDataUrl || layer.width < 1 || layer.height < 1) continue;
    const name = layer.viewRef ?? layer.name, x = layer.x + windowOrigin.x, y = layer.y + windowOrigin.y;
    if (candidates.has(key(name, x, y, layer.width, layer.height))) continue;
    const matches = [...new Set(nearbyKeys(name, x, y, layer.width, layer.height).flatMap((id) => candidates.get(id) ?? []))];
    if (matches.length !== 1 || matches[0].layerImageStatus !== "unavailable") continue;
    const node = matches[0], bounds = node.bounds!;
    if (nearbyKeys(name, bounds.left, bounds.top, layer.width, layer.height).reduce((sum, id) => sum + (counts.get(id) ?? 0), 0) !== 1) continue;
    node.layerImageDataUrl = layer.imageDataUrl;
    node.attributes = { ...node.attributes, "image-capture-source": imageSource,
      "image-source": imageSource === "sdk" ? "SDK 独立图，不含子节点" : imageSource === "ddms" ? "DDMS 批量独立图，不含子节点" : "独立图，采集通道未记录" };
    applyCapturePlacement(node, layer.geometry, layer.width, layer.height);
    node.layerImageSize = { width: layer.width, height: layer.height };
    node.layerImageStatus = "captured";
    attached += 1;
  }
  return attached;
}

/** Diagnostic only: bounded samples, no pixels, no inferred coordinate corrections. */
export function summarizeSdkGeometry(root: UiNode, layers: readonly CapturedViewLayer[]): string {
  const nodes = new Map<string, UiNode | null>(), parents = new Map<UiNode, string>();
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!, ref = node.attributes?.["view-ref"];
    if (ref) nodes.set(ref, nodes.has(ref) ? null : node);
    for (const child of node.children) { parents.set(child, ref ?? ""); pending.push(child); }
  }
  const counts = { aligned: 0, missing: 0, ambiguous: 0, invisible: 0, size: 0, position: 0 };
  const samples: unknown[] = [], deltas = new Map<string, number>();
  const short = (v: unknown) => typeof v === "string" ? v.slice(0, 256) : null;
  for (const layer of layers) {
    const node = nodes.get(layer.name), b = node?.bounds;
    const kind = node === null ? "ambiguous" : !node || !b ? "missing" : !node.visibleToUser ? "invisible"
      : layer.width !== b.right - b.left || layer.height !== b.bottom - b.top ? "size"
      : Math.abs(layer.x - b.left) > 1 || Math.abs(layer.y - b.top) > 1 ? "position" : "aligned";
    counts[kind]++;
    if (kind === "aligned") continue;
    if (b) { const key = `${layer.x - b.left},${layer.y - b.top}`; deltas.set(key, (deltas.get(key) ?? 0) + 1); }
    if (samples.length >= 8) continue;
    const geometry = layer.geometry;
    samples.push({ ref: short(layer.name), kind,
      treeSource: short(node?.attributes?.["tree-source"]),
      expected: b ? [b.left, b.top, b.right - b.left, b.bottom - b.top] : null,
      actual: [layer.x, layer.y, layer.width, layer.height], treeParent: node ? short(parents.get(node)) : null,
      // These parent positions were read in the target's drawing task, not the older tree's frame.
      evidence: geometry ? { diagnosticOnly: geometry.diagnosticOnly === true, started: geometry.started, ended: geometry.ended, rootReached: geometry.rootReached,
        chain: geometry.chain.slice(0, 2).map(row => {
          const old = nodes.get(String(row[0]))?.bounds;
          return { ref: short(row[0]), parent: short(row[1]), actual: row.slice(2, 6),
            treeSource: short(nodes.get(String(row[0]))?.attributes?.["tree-source"]),
            expected: old ? [old.left, old.top, old.right - old.left, old.bottom - old.top] : null };
        }) } : null });
  }
  return JSON.stringify({ treeSource: short(root.attributes?.["sdk-tree-source"]), counts, samples, sampled: samples.length,
    deltas: [...deltas].sort((a, b) => b[1] - a[1]).slice(0, 8), distinctDeltas: deltas.size });
}

export function matchSdkVisibleLayers(root: UiNode, layers: readonly CapturedViewLayer[]) {
  const nodes = new Map<string, UiNode>();
  const pending = [...root.children];
  while (pending.length) {
    const node = pending.pop()!;
    const ref = node.attributes?.["view-ref"];
    if (ref) nodes.set(ref, node);
    pending.push(...node.children);
  }
  const seen = new Set<string>();
  const matched: CapturedViewLayer[] = [];
  let moved = 0, unmatched = 0;
  for (const layer of layers) {
    const node = nodes.get(layer.name), bounds = node?.bounds;
    if (seen.has(layer.name)) throw new Error("SDK 可见层对象重复");
    seen.add(layer.name);
    if (!node?.visibleToUser || !bounds || layer.width !== bounds.right - bounds.left || layer.height !== bounds.bottom - bounds.top) {
      unmatched++;
      continue;
    }
    if (Math.abs(layer.x - bounds.left) > 1 || Math.abs(layer.y - bounds.top) > 1) moved++;
    else matched.push(layer);
  }
  // A mostly stale batch requires a fresh tree; a minority still uses targeted fallback.
  if (matched.length * 2 < layers.length) throw new Error(`SDK 可见层中 ${moved} 个移动、${unmatched} 个尺寸或状态变化，需要重新读取控件树`);
  return { matched, moved, unmatched, refs: new Set(nodes.keys()) };
}

export function canonicalizeSdkWindowRoot(root: UiNode, responseRoot: string): void {
  const window = root.children[0];
  if (!window || !matchesViewRoot(window.attributes?.["view-ref"] ?? "", responseRoot)) throw new Error("SDK 进程或根控件已变化");
  if (window.attributes?.["view-ref"] !== responseRoot) window.className = responseRoot.slice(0, responseRoot.lastIndexOf("@"));
  window.attributes = { ...window.attributes, "view-ref": responseRoot };
}
