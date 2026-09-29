import type { UiNode, UiSnapshot } from "../shared/types";

type RecordValue = Record<string, unknown>;
const MAX_POSITION_DRIFT_PX = 8;

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

/** Fail closed: no SDK property or old bitmap is used unless the full trees match. */
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
  if (sdkValue.classHierarchy !== undefined && !record(sdkValue.classHierarchy)) throw new Error("SDK 类继承表无效");
  const classHierarchy = sdkValue.classHierarchy;
  const seen = new Set<string>();
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
    for (const key of ["longClickable", "contextClickable", "hasOnClickListeners", "pressed", "activated"] as const) {
      if (source[key] !== undefined) properties[`sdk-${key}`] = String(boolean(source[key], key));
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
    return {
      ...old, className,
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
  return {
    ...snapshot, inspectionSource: "debug-hybrid",
    root: { ...snapshot.root, attributes: { ...snapshot.root.attributes, "tree-source": "debug-sdk", "sdk-process-instance": sdkValue.processInstance }, children: [decor] },
  };
}
