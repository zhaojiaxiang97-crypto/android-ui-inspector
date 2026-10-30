import type { PixelSize } from "./types";

type Color = [number, number, number, number];
export type QmlRectStyle = {
  fill: Color | null;
  border: Color | null;
  borderWidth: number;
  borderValidityUnknown: boolean;
  pixelAligned: boolean;
  radii: [number, number, number, number]; // top-left, top-right, bottom-right, bottom-left
  gradient: { horizontal: boolean; stops: Array<{ position: number; color: Color }> } | null;
  unsupportedGradient: boolean;
};

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
function color(value: unknown): Color | null {
  return Array.isArray(value) && value.length === 4 && value.every((n) => finite(n) && n >= 0 && n <= 1) ? value as Color : null;
}
export function qmlColorCss(value: Color) {
  return `rgba(${value.slice(0, 3).map((n) => Math.round(n * 255)).join(",")},${value[3]})`;
}

// The debug protocol transports numeric RGBA, not Qt's #AARRGGBB strings.
export function qmlStyleFrom(value: unknown): QmlRectStyle | null {
  if (!Array.isArray(value) || value.length < 7) return null;
  const [fill, border, borderWidth, radii, pixelAligned, gradient, unsupportedGradient] = value;
  if (!finite(borderWidth) || borderWidth < 0 || !Array.isArray(radii) || radii.length !== 4 || !radii.every((n) => finite(n) && n >= 0)) return null;
  let parsedGradient: QmlRectStyle["gradient"] = null;
  if (Array.isArray(gradient) && gradient.length === 2 && Array.isArray(gradient[1]) && gradient[1].length <= 256) {
    const stops: NonNullable<QmlRectStyle["gradient"]>["stops"] = [];
    for (const stop of gradient[1]) {
      if (!Array.isArray(stop) || !finite(stop[0]) || stop[0] < 0 || stop[0] > 1 || !color(stop[1])) return null;
      stops.push({ position: stop[0], color: color(stop[1])! });
    }
    parsedGradient = { horizontal: gradient[0] === true, stops: stops.sort((a, b) => a.position - b.position) };
  }
  const parsedBorder = color(border);
  // Qt's default QQuickPen reports width=1/black even while its private
  // isValid flag is false. Do not invent a black border from these defaults.
  const borderValidityUnknown = borderWidth === 1 && pixelAligned !== false && parsedBorder?.every((n, i) => n === (i === 3 ? 1 : 0)) === true;
  return { fill: color(fill), border: parsedBorder, borderWidth, borderValidityUnknown, radii: radii as QmlRectStyle["radii"], pixelAligned: pixelAligned !== false, gradient: parsedGradient, unsupportedGradient: unsupportedGradient === true };
}

function roundedPath(x: number, y: number, width: number, height: number, radii: readonly number[]) {
  const [tl, tr, br, bl] = radii.map((r) => Math.min(Math.max(0, r), width / 2, height / 2));
  const right = x + width, bottom = y + height;
  return `M${x + tl} ${y}H${right - tr}A${tr} ${tr} 0 0 1 ${right} ${y + tr}V${bottom - br}A${br} ${br} 0 0 1 ${right - br} ${bottom}H${x + bl}A${bl} ${bl} 0 0 1 ${x} ${bottom - bl}V${y + tl}A${tl} ${tl} 0 0 1 ${x + tl} ${y}Z`;
}

// Numeric, self-contained SVG: no screenshot sampling, external resources or child pixels.
// ponytail: reconstruct Rectangle/Window paint only; custom shaders and gradient presets need a Qt scene-graph capture channel.
export function qmlStyleSvg(style: QmlRectStyle, logicalSize: PixelSize, imageSize: PixelSize, deviceScale: number) {
  const { width, height } = logicalSize;
  if (![width, height, imageSize.width, imageSize.height, deviceScale].every((n) => finite(n) && n > 0)) throw new Error("QML 样式尺寸无效");
  const borderWidth = !style.borderValidityUnknown && style.border && style.border[3] > 0 ? Math.min(width / 2, height / 2, style.pixelAligned ? Math.round(style.borderWidth * deviceScale) / deviceScale : style.borderWidth) : 0;
  const outer = roundedPath(0, 0, width, height, style.radii);
  const inner = roundedPath(borderWidth, borderWidth, width - borderWidth * 2, height - borderWidth * 2, style.radii.map((r) => Math.max(0, r - borderWidth)));
  let defs = "", fill = style.fill ? qmlColorCss(style.fill) : "none";
  if (style.unsupportedGradient) fill = "none";
  else if (style.gradient) {
    if (!style.gradient.stops.length) fill = "white";
    else {
      defs = `<defs><linearGradient id="fill" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${style.gradient.horizontal ? width : 0}" y2="${style.gradient.horizontal ? 0 : height}">${style.gradient.stops.map((stop) => `<stop offset="${stop.position}" stop-color="${qmlColorCss(stop.color)}"/>`).join("")}</linearGradient></defs>`;
      fill = "url(#fill)";
    }
  }
  const border = borderWidth > 0 && style.border ? `<path d="${outer}${inner}" fill-rule="evenodd" fill="${qmlColorCss(style.border)}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${imageSize.width}" height="${imageSize.height}" viewBox="0 0 ${width} ${height}">${defs}<path d="${inner}" fill="${fill}"/>${border}</svg>`;
}
