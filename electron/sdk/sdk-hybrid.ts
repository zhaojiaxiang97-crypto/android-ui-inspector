import type { UiNode, UiSnapshot } from "../../shared/types";
import { matchesViewRoot } from "../capture/view-protocol";
import { isDebugMetadata, isDebugMetadataVersion } from "../../shared/debug-metadata";

type RecordValue = Record<string, unknown>;
export const MAX_POSITION_DRIFT_PX = 8;

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function string(value: unknown, label: string, optional = false): string | null {
  if (optional && value === undefined) return null;
  if (typeof value !== "string" || value.length > 512) throw new Error(`SDK ${label} 无效`);
  return value;
}

function integer(value: unknown, label: string, min = -100_000, max = 100_000): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`SDK ${label} 无效`);
  return value as number;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`SDK ${label} 无效`);
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`SDK ${label} 无效`);
  return value;
}

const relativeRuleNames = new Set([
  "leftOf", "rightOf", "above", "below", "alignBaseline", "alignLeft", "alignTop", "alignRight", "alignBottom",
  "alignParentLeft", "alignParentTop", "alignParentRight", "alignParentBottom", "centerInParent", "centerHorizontal",
  "centerVertical", "startOf", "endOf", "alignStart", "alignEnd", "alignParentStart", "alignParentEnd",
]);
const relativeBooleanRules = new Set([
  "alignParentLeft", "alignParentTop", "alignParentRight", "alignParentBottom", "alignParentStart", "alignParentEnd",
  "centerInParent", "centerHorizontal", "centerVertical",
]);
const constraintRuleNames = new Set([
  "leftToLeft", "leftToRight", "rightToLeft", "rightToRight", "startToStart", "startToEnd", "endToStart", "endToEnd",
  "topToTop", "topToBottom", "bottomToTop", "bottomToBottom", "baselineToBaseline", "baselineToTop", "baselineToBottom",
  "circleConstraint", "horizontalBias", "verticalBias", "circleRadius", "circleAngle", "dimensionRatio",
]);
const constraintTargetRules = new Set([
  "leftToLeft", "leftToRight", "rightToLeft", "rightToRight", "startToStart", "startToEnd", "endToStart", "endToEnd",
  "topToTop", "topToBottom", "bottomToTop", "bottomToBottom", "baselineToBaseline", "baselineToTop", "baselineToBottom",
  "circleConstraint",
]);

function sdkLayoutRules(value: unknown): string | null {
  if (value === undefined) return null;
  if (!record(value) || (value.type !== "RelativeLayout" && value.type !== "ConstraintLayout") || !record(value.rules))
    throw new Error("SDK 原生布局规则无效");
  const names = value.type === "RelativeLayout" ? relativeRuleNames : constraintRuleNames;
  const entries = Object.entries(value.rules);
  if (!entries.length || entries.length > 24) throw new Error("SDK 原生布局规则数量无效");
  const rules: Record<string, string | boolean> = {};
  for (const [name, raw] of entries) {
    if (!names.has(name)) throw new Error(`SDK 布局规则不支持：${name}`);
    if (value.type === "RelativeLayout" && relativeBooleanRules.has(name)) {
      if (typeof raw !== "boolean") throw new Error(`SDK RelativeLayout 规则无效：${name}`);
      rules[name] = raw;
      continue;
    }
    if (typeof raw !== "string" || raw.length > 256) throw new Error(`SDK 布局规则无效：${name}`);
    if ((value.type === "RelativeLayout" || constraintTargetRules.has(name))
        && !/^(?:parent|[\w.]+:id\/[\w.]+|id\/0x[a-f\d]+)$/i.test(raw))
      throw new Error(`SDK 布局目标无效：${name}`);
    if (["horizontalBias", "verticalBias", "circleRadius", "circleAngle"].includes(name)) {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || Math.abs(parsed) > 100_000
          || (name.endsWith("Bias") && (parsed < 0 || parsed > 1)) || (name === "circleRadius" && parsed < 0))
        throw new Error(`SDK 布局数值无效：${name}`);
    }
    if (name === "dimensionRatio" && !/^(?:[WH],)?\d+(?:\.\d+)?(?::\d+(?:\.\d+)?)?$/.test(raw))
      throw new Error("SDK ConstraintLayout 宽高比无效");
    rules[name] = raw;
  }
  return JSON.stringify({ type: value.type, rules });
}

/** Narrow rollout: only ordinary text leaves with a verified modern SDK binding. */
export function canUseSdkSingleTextCapture(root: UiNode, node: UiNode): boolean {
  const instance = root.attributes?.["sdk-process-instance"];
  return root.attributes?.["tree-source"] === "debug-sdk"
    && root.attributes?.["sdk-branch-geometry-version"] === "1"
    && root.attributes?.["sdk-ref-debug-canvas-version"] === "1"
    && typeof instance === "string" && /^[0-9a-f-]{36}$/i.test(instance)
    && Boolean(node.className?.endsWith("TextView")) && node.children.length === 0
    && node.attributes?.["sdk-hardwareAccelerated"] === "true"
    && Boolean(node.attributes?.["view-ref"] && node.bounds && node.visibleToUser);
}

/** Fail closed: no SDK property or old bitmap is used unless the full trees match. */
export function joinSdkRefreshEvidence(snapshot: UiSnapshot, sdk: unknown, packageName: string, pid: number, processInstance: string): UiSnapshot {
  const joined = joinSdkTreeAndDebugImages(snapshot, sdk, packageName, pid);
  if (joined.root?.attributes?.["sdk-process-instance"] !== processInstance)
    throw new Error("SDK 刷新进程身份已变化，请重新采集整页。");
  return joined;
}

export function joinSdkTreeAndDebugImages(snapshot: UiSnapshot, sdkValue: unknown, expectedPackage: string, expectedPid: number): UiSnapshot {
  if (snapshot.error || snapshot.inspectionSource !== "debug-view" || !snapshot.root || snapshot.root.children.length !== 1) {
    throw new Error("独立画面快照不是单窗口 Debug View 树");
  }
  if (!record(sdkValue) || sdkValue.version !== 1 || sdkValue.packageName !== expectedPackage
      || sdkValue.pid !== expectedPid || typeof sdkValue.processInstance !== "string"
      || !/^[0-9a-f-]{36}$/i.test(sdkValue.processInstance)
      || !Number.isSafeInteger(sdkValue.capturedAtMillis) || !record(sdkValue.root)) {
    throw new Error("SDK 树的包名、进程或协议不匹配");
  }
  const expectedCount = integer(sdkValue.nodeCount, "节点数量", 1, 5000);
  if (sdkValue.styleVersion !== undefined && sdkValue.styleVersion !== 1) throw new Error("SDK 样式协议无效");
  if (sdkValue.refDebugCanvasVersion !== undefined && sdkValue.refDebugCanvasVersion !== 1) throw new Error("SDK 文字快照协议无效");
  if (sdkValue.uiWakeVersion !== undefined && sdkValue.uiWakeVersion !== 1) throw new Error("SDK 主线程唤醒协议无效");
  if (sdkValue.debugMetadataVersion !== undefined && !isDebugMetadataVersion(sdkValue.debugMetadataVersion)) throw new Error("SDK 业务信息协议无效");
  if (sdkValue.classHierarchy !== undefined && !record(sdkValue.classHierarchy)) throw new Error("SDK 类继承表无效");
  const classHierarchy = sdkValue.classHierarchy;
  const seen = new Set<string>();
  const debugBudget = { bytes: 0 };
  const build = (source: RecordValue, old: UiNode, depth: number): UiNode => {
    if (depth > 150 || seen.size >= 5000) throw new Error("SDK 树超过深度或节点上限");
    const ref = string(source.ref, "对象身份")!;
    const className = string(source.className, "类名")!;
    if (!/^[\w.$]+@[0-9a-f]+$/i.test(ref) || ref !== old.attributes?.["view-ref"]
        || className !== old.className || seen.has(ref)) throw new Error(`SDK 与独立画面的控件身份不一致：${ref}`);
    seen.add(ref);
    const width = integer(source.width, "宽度", 0), height = integer(source.height, "高度", 0);
    const left = integer(source.screenX, "屏幕 X"), top = integer(source.screenY, "屏幕 Y");
    if (!old.bounds || Math.abs(old.bounds.left - left) > MAX_POSITION_DRIFT_PX || Math.abs(old.bounds.top - top) > MAX_POSITION_DRIFT_PX
        || old.bounds.right - old.bounds.left !== width || old.bounds.bottom - old.bounds.top !== height
        || (old.layerImageSize && (old.layerImageSize.width !== width || old.layerImageSize.height !== height))) {
      throw new Error(`SDK 与独立画面的控件位置/尺寸不一致：${ref}`);
    }
    if (old.text !== null && source.text !== undefined && old.text !== source.text) {
      throw new Error(`SDK 与独立画面的文字已变化：${ref}`);
    }
    if (!Array.isArray(source.children) || source.children.length !== old.children.length) {
      throw new Error(`SDK 与独立画面的父子关系不一致：${ref}`);
    }
    const children = source.children.map((child, index) => {
      if (!record(child)) throw new Error("SDK 子节点无效");
      return build(child, old.children[index], depth + 1);
    });
    const properties: Record<string, string> = { ...old.attributes,
      "tree-source": "debug-sdk", "sdk-alpha": String(number(source.alpha, "透明度")),
      "sdk-elevation": String(number(source.elevation, "高度")),
      "sdk-process-instance": sdkValue.processInstance as string,
    };
    const layoutRules = sdkLayoutRules(source.layoutRules);
    if (layoutRules && source.layoutParamsClass === undefined) throw new Error("SDK 原生布局规则缺少 LayoutParams");
    if (record(classHierarchy)) {
      const ancestors = classHierarchy[className];
      if (!Array.isArray(ancestors) || ancestors.length < 1 || ancestors.length > 24
          || ancestors[0] !== className || ancestors.at(-1) !== "android.view.View"
          || !ancestors.every(name => typeof name === "string" && /^[\w.$]{1,512}$/.test(name))) {
        throw new Error(`SDK 类继承链无效：${className}`);
      }
      properties["sdk-class-hierarchy"] = ancestors.join(" → ");
    }
    for (const key of ["paddingLeft", "paddingTop", "paddingRight", "paddingBottom"] as const) {
      properties[`sdk-${key}`] = String(integer(source[key], key));
    }
    for (const [key, attribute] of [["clipChildren", "clip-children"], ["clipToPadding", "clip-to-padding"]] as const) {
      if (source[key] !== undefined) properties[attribute] = String(boolean(source[key], key));
    }
    delete properties["sdk-hardwareAccelerated"];
    for (const key of ["longClickable", "contextClickable", "hasOnClickListeners", "pressed", "activated", "hardwareAccelerated"] as const) {
      if (source[key] !== undefined) properties[`sdk-${key}`] = String(boolean(source[key], key));
    }
    if (source.clipToOutline !== undefined && boolean(source.clipToOutline, "轮廓裁剪")) {
      properties["clip-to-outline"] = "true";
      const outline = ["outlineLeft", "outlineTop", "outlineRight", "outlineBottom", "outlineRadius"] as const;
      if (outline.some(key => source[key] !== undefined)) {
        if (!outline.every(key => source[key] !== undefined)) throw new Error("SDK 轮廓裁剪数据不完整");
        for (const key of outline) properties[`sdk-${key}`] = String(number(source[key], key));
      }
    }
    if (source.debugName !== undefined) {
      const name = string(source.debugName, "调试名称")!.trim();
      if (!name || name.length > 128) throw new Error("SDK 调试名称无效");
      properties["debug-name"] = name;
    }
    if (source.layoutParamsClass !== undefined) {
      properties["sdk-layout-params-class"] = string(source.layoutParamsClass, "LayoutParams 类名")!;
      properties["sdk-layout-width"] = String(integer(source.layoutWidth, "布局宽度"));
      properties["sdk-layout-height"] = String(integer(source.layoutHeight, "布局高度"));
      if (source.layoutGravity !== undefined) properties["sdk-layout-gravity"] = String(integer(source.layoutGravity, "布局重力", -1, 0x7fffffff));
      if (source.layoutWeight !== undefined) properties["sdk-layout-weight"] = String(number(source.layoutWeight, "布局权重"));
    } else if (source.layoutWidth !== undefined || source.layoutHeight !== undefined) {
      throw new Error("SDK LayoutParams 不完整");
    } else if (source.layoutGravity !== undefined || source.layoutWeight !== undefined) {
      throw new Error("SDK 布局规则缺少 LayoutParams");
    }
    const marginKeys = ["marginTop", "marginRight", "marginBottom", "marginLeft"] as const;
    if (marginKeys.some(key => source[key] !== undefined)) {
      if (!marginKeys.every(key => source[key] !== undefined) || source.layoutParamsClass === undefined) throw new Error("SDK margin 不完整");
      for (const key of marginKeys) properties[`sdk-${key}`] = String(integer(source[key], key));
    }
    if (layoutRules) properties["sdk-layout-rules"] = layoutRules;
    if (source.debugMetadata !== undefined && (!isDebugMetadataVersion(sdkValue.debugMetadataVersion) || !isDebugMetadata(source.debugMetadata, debugBudget)
        || source.debugMetadata.version > sdkValue.debugMetadataVersion))
      throw new Error("SDK 业务信息无效或超过额度");
    // A refreshed tree replaces metadata, including when the app removes all values.
    const { debugMetadata: _oldDebugMetadata, ...oldNode } = old;
    return {
      ...oldNode, className,
      ...(source.debugMetadata === undefined ? {} : { debugMetadata: structuredClone(source.debugMetadata) }),
      text: source.text === undefined ? old.text : string(source.text, "文本"),
      resourceId: source.resourceId === undefined ? old.resourceId : string(source.resourceId, "资源 ID"),
      contentDesc: source.contentDesc === undefined ? old.contentDesc : string(source.contentDesc, "描述"),
      clickable: boolean(source.clickable, "可点击"),
      enabled: boolean(source.enabled, "可用"),
      focusable: boolean(source.focusable, "可聚焦"),
      focused: boolean(source.focused, "已聚焦"),
      selected: boolean(source.selected, "已选中"),
      scrollable: boolean(source.scrollable, "可滚动"),
      // Keep DDMS effective visibility and checked geometry; SDK reports only local visibility.
      attributes: properties,
      children,
    };
  };
  const decor = build(sdkValue.root, snapshot.root.children[0], 0);
  if (seen.size !== expectedCount || seen.size + 1 !== snapshot.nodeCount) throw new Error("SDK 与独立画面的节点数量不一致");
  const { debugMetadata: _oldRootDebugMetadata, ...activityRoot } = snapshot.root;
  return {
    ...snapshot, inspectionSource: "debug-hybrid",
    root: { ...activityRoot, attributes: { ...snapshot.root.attributes, "tree-source": "debug-sdk", "sdk-process-instance": sdkValue.processInstance,
      ...(sdkValue.styleVersion === 1 ? { "sdk-style-version": "1" } : {}),
      ...(sdkValue.refDebugCanvasVersion === 1 ? { "sdk-ref-debug-canvas-version": "1" } : {}),
      "sdk-ui-wake-version": sdkValue.uiWakeVersion === 1 ? "1" : "",
      "sdk-debug-metadata-version": isDebugMetadataVersion(sdkValue.debugMetadataVersion) ? String(sdkValue.debugMetadataVersion) : "",
      "sdk-window-hardware-accelerated": decor.attributes?.["sdk-hardwareAccelerated"] ?? "",
      ...(sdkValue.branchGeometryVersion === 1 ? { "sdk-branch-geometry-version": "1" } : {}) }, children: [decor] },
  };
}

/**
 * SDK-only happy path: rebuild the tree from the SDK hierarchy without the DDMS property export.
 * The cheap dump tree is only cross-checked (refs, classes, sizes, parentage) and used as an
 * attribute donor on the legacy checked-dump path. A nonce-scoped merged capture instead
 * supplies its own authoritative hierarchy, without old properties or images; its caller
 * pins the process/window before adoption and checks the final image envelope again.
 */
export function adoptSdkTree(root: UiNode, sdkValue: unknown, expectedPackage: string, expectedPid: number,
  source: "checked-dump" | "merged-capture" = "checked-dump"): void {
  if (!root || root.children.length !== 1) throw new Error("当前控件树不是单窗口 Debug View 树");
  if (!record(sdkValue) || sdkValue.version !== 1 || sdkValue.packageName !== expectedPackage
      || sdkValue.pid !== expectedPid || typeof sdkValue.processInstance !== "string"
      || !/^[0-9a-f-]{36}$/i.test(sdkValue.processInstance)
      || !Number.isSafeInteger(sdkValue.capturedAtMillis) || !record(sdkValue.root)) {
    throw new Error("SDK 树的包名、进程或协议不匹配");
  }
  const expectedCount = integer(sdkValue.nodeCount, "节点数量", 1, 5000);
  const windowRef = string(sdkValue.root.ref, "根身份")!;
  const sources = new Map<string, RecordValue>();
  const ancestors = new Map<string, readonly string[]>();
  const pending: Array<[RecordValue, number, readonly string[]]> = [[sdkValue.root, 0, []]];
  while (pending.length) {
    const [source, depth, chain] = pending.pop()!;
    if (depth > 150 || sources.size >= 5000) throw new Error("SDK 树超过深度或节点上限");
    const ref = string(source.ref, "对象身份")!;
    if (!/^[\w.$]+@[0-9a-f]+$/i.test(ref) || sources.has(ref)) throw new Error(`SDK 控件身份无效：${ref}`);
    if (ref.slice(0, ref.lastIndexOf("@")) !== string(source.className, "类名")) throw new Error(`SDK 控件身份与类名不一致：${ref}`);
    if (!Array.isArray(source.children)) throw new Error("SDK 子节点无效");
    sources.set(ref, source);
    ancestors.set(ref, chain);
    for (const child of source.children as unknown[]) {
      if (!record(child)) throw new Error("SDK 子节点无效");
      pending.push([child, depth + 1, [...chain, ref]]);
    }
  }
  if (sources.size !== expectedCount) throw new Error("SDK 树节点数量不一致");
  if (!matchesViewRoot(root.children[0].attributes?.["view-ref"] ?? "", windowRef)) throw new Error("SDK 树的窗口与当前控件树不一致");
  const queue: Array<{ node: UiNode; parentRef: string }> = [];
  // Only the nonce-scoped merged capture may replace a changing dump hierarchy.
  // A separately read SDK tree still requires the original strict cross-check.
  if (source === "checked-dump") for (const child of root.children[0].children) queue.push({ node: child, parentRef: windowRef });
  while (queue.length) {
    const { node, parentRef } = queue.pop()!;
    const ref = node.attributes?.["view-ref"];
    if (!ref || !/^[\w.$]+@[0-9a-f]+$/i.test(ref)) throw new Error("当前控件树缺少对象身份");
    const source = sources.get(ref);
    if (!source) throw new Error(`当前控件树的控件不在 SDK 树中：${ref}`);
    if (source.className !== node.className) throw new Error(`SDK 与当前控件树的类名不一致：${ref}`);
    // The dump text drops nodes without coordinates (for example custom TextureView wrappers),
    // so the donor parent only has to sit on the SDK ancestor chain, not directly above.
    if (!ancestors.get(ref)?.includes(parentRef)) throw new Error(`SDK 与当前控件树的父子关系不一致：${ref}`);
    if (node.bounds) {
      if (node.bounds.right - node.bounds.left !== integer(source.width, "宽度", 0)
          || node.bounds.bottom - node.bounds.top !== integer(source.height, "高度", 0)) {
        throw new Error(`SDK 与当前控件树的尺寸不一致：${ref}`);
      }
    }
    for (const child of node.children) queue.push({ node: child, parentRef: ref });
  }
  const donors = new Map<string, UiNode>();
  // Never donate old properties or pixels to the authoritative same-request tree.
  const collect = source === "checked-dump" ? [...root.children] : [];
  while (collect.length) {
    const node = collect.pop()!;
    const ref = node.attributes?.["view-ref"];
    if (ref) donors.set(ref, node);
    collect.push(...node.children);
  }
  const buildSkeleton = (source: RecordValue, id: string, alpha: number, visible: boolean): UiNode => {
    const ref = string(source.ref, "对象身份")!;
    const width = integer(source.width, "宽度", 0), height = integer(source.height, "高度", 0);
    const left = integer(source.screenX, "屏幕 X"), top = integer(source.screenY, "屏幕 Y");
    const ownAlpha = Math.max(0, Math.min(1, number(source.alpha, "透明度")));
    const effective = alpha * ownAlpha;
    const visibleToUser = visible && (source.visible === undefined || boolean(source.visible, "可见")) && effective > 0;
    const children = (source.children as RecordValue[]).map((child, index) => buildSkeleton(child, `${id}/${index}`, effective, visibleToUser));
    const donor = donors.get(ref);
    return {
      id, index: Number(id.slice(id.lastIndexOf("/") + 1)), package: root.package, className: string(source.className, "类名")!,
      text: null, resourceId: null, contentDesc: null,
      bounds: { left, top, right: left + width, bottom: top + height, raw: `[${left},${top}][${left + width},${top + height}]` },
      clickable: false, enabled: true, focusable: false, focused: false, scrollable: false, selected: false,
      visibleToUser,
      attributes: { ...(donor?.attributes ?? {}), "inspection-source": "debug-view", "view-ref": ref, alpha: String(source.alpha), "effective-alpha": String(effective) },
      children,
    };
  };
  const skeleton = buildSkeleton(sdkValue.root, "0/0", 1, true);
  // Feed the SDK-shaped skeleton through the normal merger so attributes match join() exactly.
  const adopted = joinSdkTreeAndDebugImages({
    serial: "", root: { ...root, children: [skeleton] }, nodeCount: expectedCount + 1, xmlSize: 0, rawXml: null, screenshotDataUrl: null,
    error: null, warning: null, inspectionSource: "debug-view",
  }, sdkValue, expectedPackage, expectedPid);
  root.children = adopted.root!.children;
  root.attributes = adopted.root!.attributes;
  delete root.debugMetadata;
}

/** Check the current DDMS tree before choosing the SDK image path. */
export function verifySdkTreeBeforeImages(root: UiNode, nodeCount: number, sdkValue: unknown, packageName: string, pid: number): void {
  joinSdkTreeAndDebugImages({
    serial: "", root, nodeCount, xmlSize: 0, rawXml: null, screenshotDataUrl: null,
    error: null, warning: null, inspectionSource: "debug-view",
  }, sdkValue, packageName, pid);
}

/** A live group image is safe only while the selected SDK branch still describes the saved branch. */
export function sdkGroupBranchMatches(root: UiNode, nodeId: string, value: unknown, packageName: string, pid: number, instance: string): boolean {
  if (!record(value) || value.version !== 1 || value.packageName !== packageName || value.pid !== pid
      || value.processInstance !== instance || !record(value.root) || !root.children[0]
      || !/^0\/0(?:\/\d+)*$/.test(nodeId)) return false;
  let old = root.children[0], current: unknown = value.root;
  for (const part of nodeId.split("/").slice(2)) {
    const bounds = old.bounds;
    if (!record(current) || current.ref !== old.attributes?.["view-ref"] || current.className !== old.className
        || !bounds || current.screenX !== bounds.left || current.screenY !== bounds.top
        || current.width !== bounds.right - bounds.left || current.height !== bounds.bottom - bounds.top
        || !Array.isArray(current.children) || current.children.length !== old.children.length) return false;
    const index = Number(part);
    old = old.children[index]; current = current.children[index];
    if (!old) return false;
  }
  if (!old.visibleToUser || !old.children.length) return false;
  const pending: [UiNode, unknown][] = [[old, current]];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const [node, sdk] = pending[cursor], bounds = node.bounds;
    // A live group replaces its children; only the group's own frame must stay exact.
    const drift = node === old ? 0 : MAX_POSITION_DRIFT_PX;
    if (!record(sdk) || !bounds || sdk.ref !== node.attributes?.["view-ref"] || sdk.className !== node.className
        || typeof sdk.screenX !== "number" || !Number.isSafeInteger(sdk.screenX)
        || typeof sdk.screenY !== "number" || !Number.isSafeInteger(sdk.screenY)
        || Math.abs(sdk.screenX - bounds.left) > drift || Math.abs(sdk.screenY - bounds.top) > drift
        || sdk.width !== bounds.right - bounds.left || sdk.height !== bounds.bottom - bounds.top
        || (node.attributes?.["sdk-alpha"] !== undefined && sdk.alpha !== Number(node.attributes["sdk-alpha"]))
        || (node.attributes?.["clip-to-outline"] === "true" && sdk.clipToOutline !== true)
        || !Array.isArray(sdk.children) || sdk.children.length !== node.children.length) return false;
    for (const key of ["outlineLeft", "outlineTop", "outlineRight", "outlineBottom", "outlineRadius"] as const) {
      const saved = node.attributes?.[`sdk-${key}`];
      if (saved !== undefined && sdk[key] !== Number(saved)) return false;
    }
    const children = sdk.children as unknown[];
    node.children.forEach((child, index) => pending.push([child, children[index]]));
  }
  return true;
}
