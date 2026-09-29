// Android ViewHierarchyEncoder (VURT v2). Unlike the legacy reflection dump,
// this remains fast after ART has entered debugger mode.
type Value = string | number | boolean | Map<number, Value>;

export function decodeViewHierarchy(data: Buffer): string {
  let offset = 0, maps = 0;
  const fail = () => { throw new Error("Debug V2 控件属性不完整或格式无效。"); };
  const take = (size: number) => {
    if (offset + size > data.length) fail();
    const bytes = data.subarray(offset, offset + size); offset += size; return bytes;
  };
  const short = () => { if (take(1)[0] !== 83) fail(); return take(2).readUInt16BE(); };
  const read = (depth = 0): Value => {
    const tag = take(1)[0];
    switch (tag) {
      case 90: { const value = take(1)[0]; if (value > 1) fail(); return value === 1; }
      case 66: return take(1).readInt8();
      case 83: return take(2).readInt16BE();
      case 73: return take(4).readInt32BE();
      case 74: { const value = Number(take(8).readBigInt64BE()); if (!Number.isSafeInteger(value)) fail(); return value; }
      case 70: return take(4).readFloatBE();
      case 68: return take(8).readDoubleBE();
      case 82: return take(take(2).readUInt16BE()).toString("utf8");
      case 77: {
        if (depth > 204 || ++maps > 150_000) fail();
        const values = new Map<number, Value>();
        for (let key = short(); key !== 0; key = short()) {
          const value = read(depth + 1);
          // Subclasses can re-export a base property; Android uses the last value.
          values.set(key, value);
        }
        return values;
      }
      default: return fail();
    }
  };
  const windowProperties = new Map<number, Value>();
  while (data[offset] === 83) windowProperties.set(short(), read());
  const root = read(), index = read();
  if (offset !== data.length || !(root instanceof Map) || !(index instanceof Map)) return fail();
  const names = new Map<string, number>();
  for (const [id, name] of index) {
    if (typeof name !== "string" || names.has(name)) fail();
    names.set(name as string, id);
  }
  if (!names.has("__name__") || !names.has("meta:__name__") || !names.has("meta:__hash__")) return fail();
  const get = (map: Map<number, Value>, key: string) => map.get(names.get(key)!);
  const number = (map: Map<number, Value>, key: string, fallback?: number): number => {
    const value = get(map, key) ?? fallback;
    if (typeof value !== "number" || !Number.isFinite(value)) return fail();
    return value;
  };
  const aliases: Record<string, string> = {
    "id": "mID", "misc:visibility": "getVisibility()", "misc:clickable": "isClickable()",
    "misc:enabled": "isEnabled()", "misc:selected": "isSelected()",
    "focus:isFocusable": "focus:isFocusable()", "focus:isFocused": "focus:isFocused()",
    "drawing:alpha": "drawing:getAlpha()", "drawing:elevation": "drawing:getElevation()",
    "drawing:translationZ": "drawing:getTranslationZ()", "drawing:rotation": "drawing:getRotation()",
    "drawing:scaleX": "drawing:getScaleX()", "drawing:scaleY": "drawing:getScaleY()",
    "drawing:clipChildren": "drawing:getClipChildren()", "drawing:clipToPadding": "drawing:getClipToPadding()",
    "padding:paddingLeft": "padding:mPaddingLeft", "padding:paddingTop": "padding:mPaddingTop",
    "padding:paddingRight": "padding:mPaddingRight", "padding:paddingBottom": "padding:mPaddingBottom",
    "text:text": "text:mText", "accessibility:contentDescription": "accessibility:getContentDescription()",
  };
  const lines: string[] = [], identities = new Set<string>();
  // Map the local origin through every parent's matrix and scroll, as
  // View.getLocationOnScreen does. Keep native (unscaled) bitmap dimensions.
  type Matrix = [number, number, number, number, number, number];
  const visit = (map: Map<number, Value>, parent: Matrix, depth: number, geometryKnown: boolean) => {
    if (depth > 198 || identities.size >= 50_000) fail();
    const name = get(map, "meta:__name__"), hash = number(map, "meta:__hash__");
    if (typeof name !== "string" || !/^[\w.$]+$/.test(name) || !Number.isInteger(hash)) fail();
    const ref = `${name}@${(hash >>> 0).toString(16)}`;
    if (identities.has(ref)) fail();
    identities.add(ref);
    const width = number(map, "layout:width"), height = number(map, "layout:height");
    if (width < 0 || height < 0) fail();
    const sx = number(map, "drawing:scaleX", 1), sy = number(map, "drawing:scaleY", 1);
    const angle = number(map, "drawing:rotation", 0) * Math.PI / 180;
    const px = number(map, "drawing:pivotX", width / 2), py = number(map, "drawing:pivotY", height / 2);
    const a = Math.cos(angle) * sx, b = Math.sin(angle) * sx, c = -Math.sin(angle) * sy, d = Math.cos(angle) * sy;
    const tx = number(map, "layout:left") + number(map, "drawing:translationX", 0) + px - a * px - c * py;
    const ty = number(map, "layout:top") + number(map, "drawing:translationY", 0) + py - b * px - d * py;
    const [pa, pb, pc, pd, ptx, pty] = parent;
    const matrix: Matrix = [pa * a + pc * b, pb * a + pd * b, pa * c + pc * d, pb * c + pd * d, pa * tx + pc * ty + ptx, pb * tx + pd * ty + pty];
    geometryKnown &&= number(map, "drawing:rotationX", 0) === 0 && number(map, "drawing:rotationY", 0) === 0;
    const values: Record<string, string> = {};
    for (const [source, destination] of Object.entries(aliases)) {
      const value = get(map, source);
      if (value !== undefined && !(value instanceof Map)) values[destination] = String(value).replace(/\r/g, "\\r").replace(/\n/g, "\\n");
    }
    if (values.mID === "-1") values.mID = "NO_ID";
    if (geometryKnown) {
      values["layout:getLocationOnScreen_x()"] = String(Math.round(matrix[4]));
      values["layout:getLocationOnScreen_y()"] = String(Math.round(matrix[5]));
      values["layout:getWidth()"] = String(width);
      values["layout:getHeight()"] = String(height);
    } else values["geometry-error"] = "V2 未暴露三维变换矩阵，未猜测控件坐标";
    lines.push(`${" ".repeat(depth)}${ref} ${Object.entries(values).map(([key, value]) => `${key}=${value.length},${value}`).join(" ")} `);
    const scrollX = number(map, "scrolling:scrollX", 0), scrollY = number(map, "scrolling:scrollY", 0);
    matrix[4] -= matrix[0] * scrollX + matrix[2] * scrollY;
    matrix[5] -= matrix[1] * scrollX + matrix[3] * scrollY;
    const count = number(map, "meta:__childCount__", 0);
    if (!Number.isInteger(count) || count < 0 || count > 50_000) fail();
    for (let i = 0; i < count; i++) {
      const child = get(map, `meta:__child__${i}`);
      if (!(child instanceof Map)) return fail();
      visit(child, matrix, depth + 1, geometryKnown);
    }
  };
  visit(root, [1, 0, 0, 1, number(windowProperties, "window:left"), number(windowProperties, "window:top")], 0, true);
  return lines.join("\n") + "\nDONE.\n";
}
