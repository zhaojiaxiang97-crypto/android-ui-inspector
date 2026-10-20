import type { UiBounds, UiNode } from "../../shared/types";
import { matchesViewRoot } from "./view-protocol";
import { type ForegroundTarget } from "../device/target";
import { MAX_UI_HIERARCHY_DEPTH } from "./xml-tree";


export function countNodes(node: UiNode): number {
  let count = 0;
  const pending = [node];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    count += 1;
    pending.push(...pending[cursor].children);
  }
  return count;
}

export function hasActivityHierarchy(section: string, target: ForegroundTarget) {
  if (section.includes("org.qtproject.qt.android.")) return true;
  try { debugViewTree(section, target); return true; }
  catch (error) {
    if (error instanceof Error && /无法从 Debug App 读取 View Hierarchy|未读取到 Debug View 节点/.test(error.message)) return false;
    throw error;
  }
}

export function activityTreeReadinessReason(section: string): string {
  return /Failure while dumping the activity:[^\n]*Timeout/.test(section)
    ? "App 未及时返回当前 Activity 控件树（系统 dump 超时）"
    : "当前 Activity 尚未提供有效 View Hierarchy";
}

export function appBounds(section: string): UiBounds | null {
  const match = section.match(/mAppBounds=Rect\((-?\d+),\s*(-?\d+)\s*-\s*(-?\d+),\s*(-?\d+)\)/);
  if (!match) return null;
  const [, left, top, right, bottom] = match.map(Number);
  return { left, top, right, bottom, raw: `[${left},${top}][${right},${bottom}]` };
}

export function debugViewTree(section: string, target: ForegroundTarget): UiNode {
  const hierarchy = section.split("View Hierarchy:")[1]?.split("\n    Looper")[0];
  if (!hierarchy) throw new Error("无法从 Debug App 读取 View Hierarchy。");
  if (hierarchy.includes("AndroidComposeView")) throw new Error("当前版本尚未支持 Compose Debug 控件树。");

  const rootBounds = appBounds(section);
  const root: UiNode = {
    id: "0",
    index: 0,
    className: target.activityName,
    package: target.packageName,
    text: null,
    resourceId: null,
    contentDesc: null,
    bounds: rootBounds,
    clickable: false,
    enabled: true,
    focusable: false,
    focused: false,
    scrollable: false,
    selected: false,
    visibleToUser: true,
    attributes: { "inspection-source": "debug-view" },
    children: [],
  };
  const stack: Array<{ indent: number; node: UiNode; left: number; top: number }> = [{ indent: -1, node: root, left: 0, top: 0 }];

  for (const line of hierarchy.split(/\r?\n/)) {
    const match = line.match(/^(\s+)([^\s{]+)\{([^}]*)\}(.*)$/);
    const decor = line.match(/^(\s+)(DecorView)@([0-9a-f]+)\[[^\r\n]*\]\s*$/i);
    const identity = match ?? decor;
    if (!identity) continue;
    const indent = identity[1].length;
    const className = identity[2].split("@")[0];
    const details = match?.[3] ?? "";
    const coordinates = details.match(/\s(-?\d+),(-?\d+)-(-?\d+),(-?\d+)(?:\s|$)/);
    if (!coordinates && !decor) continue;
    while (stack.length > 1 && stack.at(-1)!.indent >= indent) stack.pop();
    const parent = stack.at(-1)!;
    const localLeft = Number(coordinates?.[1] ?? 0);
    const localTop = Number(coordinates?.[2] ?? 0);
    const left = parent.left + localLeft;
    const top = parent.top + localTop;
    const right = parent.left + Number(coordinates?.[3] ?? 0);
    const bottom = parent.top + Number(coordinates?.[4] ?? 0);
    const flags = details.trim().split(/\s+/)[1] ?? "";
    const resourceId = details.match(/#\S+\s+([^\s}]+:id\/[^\s}]+)/)?.[1] ?? null;
    const text = match?.[4].match(/^\(([^)]*)\)/)?.[1] || null;
    const index = parent.node.children.length;
    const node: UiNode = {
      id: `${parent.node.id}/${index}`,
      index,
      className,
      package: target.packageName,
      text,
      resourceId,
      contentDesc: null,
      bounds: coordinates ? { left, top, right, bottom, raw: `[${left},${top}][${right},${bottom}]` } : null,
      clickable: flags.includes("C"),
      enabled: Boolean(decor) || flags.includes("E"),
      focusable: flags.includes("F"),
      focused: false,
      scrollable: className.includes("Scroll") || className.includes("Recycler"),
      selected: false,
      visibleToUser: Boolean(decor) || flags.startsWith("V"),
      attributes: { "inspection-source": "debug-view", "view-flags": flags, "view-ref": `${className}@${decor?.[3] ?? details.trim().split(/\s+/)[0]}` },
      children: [],
    };
    parent.node.children.push(node);
    stack.push({ indent, node, left, top });
  }
  if (root.children.length === 0) throw new Error("未读取到 Debug View 节点。");
  return root;
}

function applyTextStyle(attributes: Record<string, string>, values: Record<string, string>) {
  const fields = {
    "text-size-px": ["text:textSize", "text:getTextSize()"],
    "text-typeface-style": ["text:typefaceStyle", "text:getTypefaceStyle()"],
    "text-color-argb": ["text:curTextColor", "text:mCurTextColor"],
    "text-gravity": ["text:gravity", "text:mGravity"],
    "text-ellipsize": ["text:ellipsize", "getEllipsize()"],
    "text-alignment": ["text:textAlignment", "text:getTextAlignment()"],
    "text-direction": ["text:textDirection", "text:getTextDirection()"],
    "layout-direction": ["layout:layoutDirection", "layout:getLayoutDirection()"],
  };
  type Field = keyof typeof fields;
  const raw = (key: Field) => fields[key].map(name => values[name]).find(value => value !== undefined);
  const numeric = (key: Field) => {
    const value = raw(key);
    return value !== undefined && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
  };
  // These values belong to this tree read; do not retain an older style when
  // the framework stops exporting it or returns an invalid optional property.
  for (const key of [...Object.keys(fields), "text-style-source"]) delete attributes[key];
  const size = numeric("text-size-px");
  if (size !== null && size >= 0) attributes["text-size-px"] = String(size);
  const style = raw("text-typeface-style");
  const styleNames: Record<string, number> = { NORMAL: 0, BOLD: 1, ITALIC: 2, BOLD_ITALIC: 3 };
  const styleValue = values["text:typefaceStyle"] === undefined && style !== undefined && Object.prototype.hasOwnProperty.call(styleNames, style)
    ? styleNames[style] : numeric("text-typeface-style");
  if (styleValue !== null && Number.isInteger(styleValue) && styleValue >= 0 && styleValue <= 3)
    attributes["text-typeface-style"] = String(styleValue);
  const color = numeric("text-color-argb");
  if (color !== null && Number.isInteger(color) && color >= -0x80000000 && color <= 0xffffffff)
    attributes["text-color-argb"] = `#${(color >>> 0).toString(16).padStart(8, "0").toUpperCase()}`;
  const gravity = numeric("text-gravity");
  if (gravity !== null && Number.isInteger(gravity) && gravity >= 0 && gravity <= 0x7fffffff)
    attributes["text-gravity"] = String(gravity);
  const ellipsize = raw("text-ellipsize");
  // V2 encodes a null String as ""; legacy reflection writes "null".
  // An absent field is different from explicitly disabled ellipsizing.
  if (values["text:ellipsize"] === "" || values["text:ellipsize"] === undefined && ellipsize === "null") attributes["text-ellipsize"] = "NONE";
  else if (ellipsize !== undefined && ["START", "MIDDLE", "END", "MARQUEE", "END_SMALL"].includes(ellipsize))
    attributes["text-ellipsize"] = ellipsize;
  const hasTextStyle = ["text-size-px", "text-typeface-style", "text-color-argb", "text-gravity", "text-ellipsize"].some(key => attributes[key] !== undefined);
  if (hasTextStyle) attributes["text-style-source"] = "view-debug";
  for (const [key, max] of [["text-alignment", 6], ["text-direction", 7], ["layout-direction", 3]] as const) {
    const value = numeric(key);
    if (value !== null && Number.isInteger(value) && value >= 0 && value <= max) attributes[key] = String(value);
  }
}

export function applyViewProperties(root: UiNode, dump: string, restoreHierarchy = false) {
  const properties = new Map<string, Record<string, string>>();
  const records: Array<{ ref: string; indent: number }> = [];
  for (const line of dump.split("\n")) {
    const header = line.match(/^(\s*)(\S+@\w+) /);
    if (!header) {
      if (restoreHierarchy && line.trim() && line.trim() !== "DONE.") throw new Error("Debug 控件树记录格式无效。");
      continue;
    }
    const values: Record<string, string> = {};
    let offset = header[0].length;
    while (offset < line.length) {
      const field = line.slice(offset).match(/^([^= ]+)=(\d+),/);
      if (!field) throw new Error("Debug 控件属性格式不完整。");
      offset += field[0].length;
      const length = Number(field[2]);
      if (!Number.isSafeInteger(length) || offset + length > line.length) throw new Error("Debug 控件属性长度无效。");
      if (offset + length < line.length && line[offset + length] !== " ") throw new Error("Debug 控件属性分隔符无效。");
      values[field[1]] = line.slice(offset, offset + length);
      offset += length + 1;
    }
    if (properties.has(header[2])) throw new Error("Debug 控件对象身份重复，请重新采集。");
    properties.set(header[2], values);
    records.push({ ref: header[2], indent: header[1].length });
  }
  const windowRef = dump.trimStart().split(/\s/)[0];
  for (const node of root.children) {
    const ref = node.attributes?.["view-ref"];
    if (ref && matchesViewRoot(ref, windowRef)) {
      node.className = windowRef.split("@")[0];
      node.attributes = { ...node.attributes, "view-ref": windowRef };
    }
  }
  if (restoreHierarchy) {
    if (!records.length || records.length > 50_000 || records[0].indent !== 0
      || !root.children.some((node) => matchesViewRoot(node.attributes?.["view-ref"] ?? "", records[0].ref))) {
      throw new Error("Debug 控件树不完整或根窗口已变化，请重新采集。");
    }
    const previous = new Map<string, UiNode>();
    const pending = [...root.children];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.attributes?.["view-ref"]) previous.set(node.attributes["view-ref"], node);
      pending.push(...node.children);
    }
    const rebuilt = { ...root, children: [] as UiNode[] };
    const parents = [{ node: rebuilt, indent: -1 }];
    for (const record of records) {
      while (parents.length > 1 && parents.at(-1)!.indent >= record.indent) parents.pop();
      if (parents.length > MAX_UI_HIERARCHY_DEPTH || (parents.length === 1 && rebuilt.children.length)) throw new Error("Debug 控件树结构无效。");
      const parent = parents.at(-1)!.node;
      const old = previous.get(record.ref);
      const index = parent.children.length;
      const node: UiNode = {
        id: `${parent.id}/${index}`, index, package: root.package, className: record.ref.split("@")[0],
        text: old?.text ?? null, resourceId: old?.resourceId ?? null, contentDesc: old?.contentDesc ?? null,
        bounds: null, clickable: false, enabled: true, focusable: false, focused: false,
        scrollable: /Scroll|Recycler/.test(record.ref), selected: false, visibleToUser: true,
        attributes: { "inspection-source": "debug-view", "view-ref": record.ref }, children: [],
      };
      parent.children.push(node);
      parents.push({ node, indent: record.indent });
    }
    root.children = rebuilt.children;
  }
  const stack = [{ node: root, alpha: 1, visible: true }];
  while (stack.length) {
    const { node, alpha, visible } = stack.pop()!;
    const values = properties.get(node.attributes?.["view-ref"] ?? "");
    const ownAlpha = Number(values?.["drawing:getAlpha()"] ?? 1);
    const effectiveAlpha = alpha * (Number.isFinite(ownAlpha) ? Math.max(0, Math.min(1, ownAlpha)) : 1);
    node.attributes = { ...node.attributes, "effective-alpha": String(effectiveAlpha) };
    node.visibleToUser = visible && (values?.["getVisibility()"] !== undefined ? ["VISIBLE", "0"].includes(values["getVisibility()"]) : node.visibleToUser) && effectiveAlpha > 0;
    if (values) {
      applyTextStyle(node.attributes, values);
      if (values["geometry-error"]) node.attributes["geometry-error"] = values["geometry-error"];
      node.attributes["alpha"] = String(ownAlpha);
      const layerName = values["mID"];
      if (layerName && layerName !== "NO_ID") {
        node.attributes["debug-layer-name"] = layerName;
        // DDMS does not include the resource namespace; do not invent one.
        if (!node.resourceId && layerName.startsWith("id/")) node.resourceId = layerName;
      }
      const privateFlags = values["mPrivateFlags"];
      if (privateFlags && /^0x[\da-f]+$/i.test(privateFlags)) node.attributes["skip-draw"] = String((Number(privateFlags) & 0x80) !== 0);
      for (const [property, key] of [["clickable", "isClickable()"], ["enabled", "isEnabled()"], ["focusable", "focus:isFocusable()"], ["focused", "focus:isFocused()"], ["selected", "isSelected()"]] as const) {
        if (values[key] === "true" || values[key] === "false") node[property] = values[key] === "true";
      }
      const text = values["text:mText"] ?? values["text:getText()"];
      if (text !== undefined) node.text = text === "null" ? null : text;
      const description = values["accessibility:getContentDescription()"];
      if (description !== undefined) node.contentDesc = description === "null" ? null : description;
      const exported = {
        "hardware-accelerated": ["drawing:isHardwareAccelerated()"],
        z: ["drawing:getZ()"],
        elevation: ["drawing:getElevation()"],
        "translation-z": ["drawing:getTranslationZ()"],
        "clip-children": ["drawing:getClipChildren()"],
        "clip-to-padding": ["drawing:getClipToPadding()"],
        "padding-left": ["padding:mPaddingLeft", "padding:getPaddingLeft()"],
        "padding-top": ["padding:mPaddingTop", "padding:getPaddingTop()"],
        "padding-right": ["padding:mPaddingRight", "padding:getPaddingRight()"],
        "padding-bottom": ["padding:mPaddingBottom", "padding:getPaddingBottom()"],
        rotation: ["drawing:getRotation()"],
        "scale-x": ["drawing:getScaleX()"],
        "scale-y": ["drawing:getScaleY()"],
      };
      for (const [key, aliases] of Object.entries(exported)) {
        const value = aliases.map((alias) => values[alias]).find((value) => value !== undefined);
        if (value !== undefined && (value === "true" || value === "false" || (value.trim() !== "" && Number.isFinite(Number(value))))) node.attributes[key] = value;
      }
      const x = Number(values["layout:getLocationOnScreen_x()"]);
      const y = Number(values["layout:getLocationOnScreen_y()"]);
      const width = Number(values["layout:getWidth()"]);
      const height = Number(values["layout:getHeight()"]);
      if ([x, y, width, height].every(Number.isFinite)) node.bounds = { left: x, top: y, right: x + width, bottom: y + height, raw: `[${x},${y}][${x + width},${y + height}]` };
    }
    for (const child of node.children) stack.push({ node: child, alpha: effectiveAlpha, visible: node.visibleToUser });
  }
}

export function nodeById(root: UiNode, id: string): UiNode | null {
  const pending = [root];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const node = pending[cursor];
    if (node.id === id) return node;
    pending.push(...node.children);
  }
  return null;
}

export function nativeViewNodeMatches(expectedRoot: UiNode, currentRoot: UiNode, nodeId: string): boolean {
  let expected = expectedRoot, current = currentRoot;
  if (nodeId === expectedRoot.id) return false;
  for (const part of nodeId.split("/").slice(1)) {
    if (!/^\d+$/.test(part)) return false;
    const index = Number(part);
    expected = expected.children[index]; current = current.children[index];
    if (!expected || !current || !expected.attributes?.["view-ref"]
      || expected.attributes["view-ref"] !== current.attributes?.["view-ref"]
      || expected.className !== current.className) return false;
  }
  return Boolean(expected.bounds && current.bounds && expected.visibleToUser && current.visibleToUser
    && expected.children.length === current.children.length
    && expected.children.every((child, index) => child.attributes?.["view-ref"] === current.children[index].attributes?.["view-ref"]));
}

export function nativeViewBranchMatches(expectedRoot: UiNode, currentRoot: UiNode, nodeId: string): boolean {
  if (!nativeViewNodeMatches(expectedRoot, currentRoot, nodeId)) return false;
  const expected = nodeById(expectedRoot, nodeId), current = nodeById(currentRoot, nodeId);
  if (!expected || !current) return false;
  const pending: [UiNode, UiNode][] = [[expected, current]];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const [a, b] = pending[cursor];
    if (a.id !== b.id || a.className !== b.className || a.attributes?.["view-ref"] !== b.attributes?.["view-ref"] || a.children.length !== b.children.length) return false;
    a.children.forEach((child, index) => pending.push([child, b.children[index]]));
  }
  return true;
}

// 分支刷新身份校验失败时定位第一个差异点（仅诊断日志使用，不参与判定）。
export function describeBranchContextMismatch(expectedRoot: UiNode, currentRoot: UiNode, branchId: string): string {
  const expected = nodeById(expectedRoot, branchId), current = nodeById(currentRoot, branchId);
  if (!expected || !current) return `分支节点在${!expected ? "快照" : "活树"}中缺失`;
  const pending: [UiNode, UiNode][] = [[expectedRoot, currentRoot]];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const [old, latest] = pending[cursor];
    if (old.id !== latest.id || old.className !== latest.className || old.attributes?.["view-ref"] !== latest.attributes?.["view-ref"])
      return `节点不一致：${old.id} ${old.className} → ${latest.id} ${latest.className}`;
    if (branchId.startsWith(`${old.id}/`) && old.bounds?.raw !== latest.bounds?.raw)
      return `祖先边界变化：${old.id} ${old.className} ${old.bounds?.raw} → ${latest.bounds?.raw}`;
    if (old.id !== branchId && old.visibleToUser !== latest.visibleToUser)
      return `祖先可见性变化：${old.id} ${old.className} ${old.visibleToUser} → ${latest.visibleToUser}`;
    if (old.id === branchId) return "分支节点通过（不应到达）";
    if (old.children.length !== latest.children.length)
      return `子节点数变化：${old.id} ${old.className} ${old.children.length} → ${latest.children.length}（新增/删除了分支外兄弟）`;
    old.children.forEach((child, index) => pending.push([child, latest.children[index]]));
  }
  return "结构一致（不应到达）";
}

export function nativeViewBranchContextMatches(expectedRoot: UiNode, currentRoot: UiNode, branchId: string): boolean {
  if (!nodeById(expectedRoot, branchId) || !nodeById(currentRoot, branchId)) return false;
  const pending: [UiNode, UiNode][] = [[expectedRoot, currentRoot]];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const [old, latest] = pending[cursor];
    if (old.id !== latest.id || old.className !== latest.className || old.attributes?.["view-ref"] !== latest.attributes?.["view-ref"]
        || branchId.startsWith(`${old.id}/`) && old.bounds?.raw !== latest.bounds?.raw
        || old.id !== branchId && old.visibleToUser !== latest.visibleToUser
        || old.id !== expectedRoot.id && !old.attributes?.["view-ref"]) return false;
    if (old.id === branchId) continue;
    if (old.children.length !== latest.children.length) return false;
    old.children.forEach((child, index) => pending.push([child, latest.children[index]]));
  }
  return true;
}

// 分支刷新读树时可能出现的瞬时失败（JDWP 属性流编码竞态、dumpsys 段落缺层级、空回包）：
// 重读一次通常可恢复；身份/层级变化类错误不在此列，绝不重试。
export function isTransientTreeReadError(message: string): boolean {
  return /Debug V2|返回内容为空|返回了无效数据|无法从 Debug App 读取 View Hierarchy|Debug View 连接超时|未读取到 Debug View 节点/.test(message);
}
