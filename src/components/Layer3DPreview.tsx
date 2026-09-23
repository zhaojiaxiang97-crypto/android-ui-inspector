import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { PixelSize, UiNode } from "../../shared/types";
import { buildLayerOverview, type LayerRecord } from "../../shared/layer-layout";
import { composeSubtreeImage, subtreeImageNodes, textureDimensions } from "../../shared/layer-textures";
import { measureBounds, type BoundsMeasurement } from "../../shared/node-metrics";
import { nodeDisplayLabel, nodeShortClass } from "../../shared/tree-utils";

export type LayerCamera = {
  distance: number;
  azimuth: number;
  elevation: number;
  roll: number;
  layerGap: number;
  panX: number;
  panY: number;
};

export type LayerSceneHandle = {
  paintCamera: (camera: LayerCamera) => void;
  fit: () => void;
  pick: (clientX: number, clientY: number) => UiNode | null;
  hover: (clientX: number, clientY: number) => void;
  clearHover: () => void;
};

type Props = {
  src: string;
  root: UiNode;
  selectedNode: UiNode | null;
  expandedNodeIds: ReadonlySet<string>;
  hiddenNodeIds?: ReadonlySet<string>;
  size: PixelSize;
  renderScale: number;
  origin: Pick<Rect, "left" | "top">;
  camera: LayerCamera;
  onSelect: (node: UiNode) => void;
  onFitScale?: (scale: number) => void;
};

type LayerPlaneRole = "surface" | "outline";
type RenderKind = "native" | "composite" | "isolated" | "outline" | "selection" | "hover";
type Rect = { left: number; top: number; width: number; height: number };
type ScenePlane = { id: string; node: UiNode | null; rect: Rect; source: Rect; textureSrc: string | null; textureSize: PixelSize; z: number; kind: RenderKind; opacity: number; hitTestable: boolean };
type Point = { x: number; y: number };
type ScenePivot = Point & { z: number };
type ProjectedPlane = { node: UiNode; corners: Point[]; depth: number };
type RendererStatus = "loading" | "webgl" | "fallback";
type Renderer = {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  quadBuffer: WebGLBuffer;
  lineBuffer: WebGLBuffer;
  texture: WebGLTexture;
  layerTextures: Map<string, WebGLTexture>;
  layerTextureBytes: Map<string, number>;
  unitLocation: number;
  uniforms: Record<string, WebGLUniformLocation>;
  textureReady: boolean;
  cssWidth: number;
  cssHeight: number;
  renderVersion: number;
};

const MAX_CANVAS_PIXELS = 4_000_000;
const NO_HIDDEN_NODES: ReadonlySet<string> = new Set();
const MAX_LAYER_TEXTURE_PIXELS = 16_000_000;
const CONTENT_CLASS_PATTERN = /(TextView|ImageView|ImageButton|Button|EditText|CheckBox|RadioButton|Switch|ToggleButton|ProgressBar|SeekBar|WebView|SurfaceView|TextureView|VideoView)/i;
const STRUCTURAL_CLASS_PATTERN = /(FrameLayout|LinearLayout|RelativeLayout|ConstraintLayout|ViewGroup|ViewPager|SlidingPaneLayout|RecyclerView|ScrollView|DrawerLayout|CoordinatorLayout)/i;
const TEXT_ONLY_CLASS_PATTERN = /TextView$/i;
const OUTLINE_COLOR: readonly [number, number, number] = [0.42, 0.49, 0.56];
const SELECTION_COLOR: readonly [number, number, number] = [0.51, 0.78, 0.25];
const HOVER_COLOR: readonly [number, number, number] = [0.20, 0.56, 0.96];

const VERTEX_SHADER = `
  attribute vec2 a_unit;
  uniform vec4 u_rect;
  uniform mediump vec4 u_source_rect;
  uniform vec2 u_viewport;
  uniform vec3 u_pivot;
  uniform float u_depth;
  uniform float u_distance;
  uniform vec4 u_rotation;
  uniform vec2 u_roll;
  varying vec2 v_uv;
  varying vec2 v_source;
  void main() {
    float px = u_rect.x + a_unit.x * u_rect.z - u_pivot.x;
    float py = u_pivot.y - (u_rect.y + a_unit.y * u_rect.w);
    float pz = u_depth - u_pivot.z;
    float x_yaw = u_rotation.x * px + u_rotation.y * pz;
    float z_yaw = -u_rotation.y * px + u_rotation.x * pz;
    float y_pitch = u_rotation.z * py - u_rotation.w * z_yaw;
    float z_pitch = u_rotation.w * py + u_rotation.z * z_yaw;
    float x_roll = u_roll.x * x_yaw - u_roll.y * y_pitch;
    float y_roll = u_roll.y * x_yaw + u_roll.x * y_pitch;
    float clip_w = max(1.0, u_distance - z_pitch);
    float clip_x = (u_pivot.x / (u_viewport.x * 0.5) - 1.0) * clip_w + x_roll * u_distance / (u_viewport.x * 0.5);
    float clip_y = (1.0 - u_pivot.y / (u_viewport.y * 0.5)) * clip_w + y_roll * u_distance / (u_viewport.y * 0.5);
    // Keep clip-space W so WebGL perspective-correctly interpolates the
    // screenshot texture across a tilted plane instead of shearing it.
    gl_Position = vec4(clip_x, clip_y, 0.0, clip_w);
    v_uv = a_unit;
    v_source = u_source_rect.xy + a_unit * u_source_rect.zw;
  }
`;

const FRAGMENT_SHADER = `
  precision mediump float;
  uniform sampler2D u_texture;
  uniform mediump vec4 u_source_rect;
  uniform vec4 u_color;
  uniform vec2 u_rect_size;
  uniform float u_kind;
  uniform float u_opacity;
  varying vec2 v_uv;
  varying vec2 v_source;
  void main() {
    if (u_kind < 1.5) {
      vec4 source = texture2D(u_texture, v_source);
      gl_FragColor = vec4(source.rgb, source.a * u_opacity);
      return;
    }
    if (u_kind < 2.5) {
      vec3 center = texture2D(u_texture, v_source).rgb;
      vec2 inset = u_source_rect.zw * 0.08;
      vec3 background = (
        texture2D(u_texture, u_source_rect.xy + inset).rgb +
        texture2D(u_texture, u_source_rect.xy + vec2(u_source_rect.z - inset.x, inset.y)).rgb +
        texture2D(u_texture, u_source_rect.xy + vec2(inset.x, u_source_rect.w - inset.y)).rgb +
        texture2D(u_texture, u_source_rect.xy + u_source_rect.zw - inset).rgb
      ) * 0.25;
      float glyph = smoothstep(0.07, 0.22, length(center - background));
      if (glyph < 0.01) discard;
      gl_FragColor = vec4(center, glyph * u_opacity);
      return;
    }
    if (u_kind > 3.5) {
      vec2 edge_pixels = min(v_uv, 1.0 - v_uv) * u_rect_size;
      float edge = 1.0 - smoothstep(0.7, 1.5, min(edge_pixels.x, edge_pixels.y));
      gl_FragColor = vec4(u_color.rgb, edge * u_opacity);
      return;
    }
    gl_FragColor = vec4(u_color.rgb, u_opacity);
  }
`;

function radians(value: number) {
  return value * Math.PI / 180;
}

function hasOwnVisualStyle(record: LayerRecord, size: PixelSize, hiddenNodeIds?: ReadonlySet<string>) {
  const node = record.node;
  // Collapsed branches combine independent images; expanded nodes keep their own.
  if (record.isCollapsed) return subtreeImageNodes(node, hiddenNodeIds).length > 0;
  if (node.layerImageEmpty) return false;
  if (node.layerImageDataUrl && node.layerImageSize) return true;
  // Without an independent bitmap, keep structural nodes as outlines.
  if (node.children.length > 0 || isNearFullScreen(record, size) || STRUCTURAL_CLASS_PATTERN.test(node.className ?? "")) return false;
  // Debug View bitmaps are already isolated by Android. If one is missing,
  // an outline is safer than leaking pixels from the flattened screenshot.
  if (node.attributes?.["inspection-source"] === "debug-view") return false;
  // A virtual accessibility leaf has no isolated bitmap. Its bounds crop is
  // the closest representation of the child window, including its background.
  if (record.isVirtual) return Boolean(node.text?.trim() || node.contentDesc?.trim());
  // ponytail: Android debug trees have no isolated view bitmap; texture only leaf views so parent/child pixels are not copied into each other.
  if (node.text?.trim() || node.contentDesc?.trim()) return true;
  if (CONTENT_CLASS_PATTERN.test(node.className ?? "")) return true;
  if (node.clickable || node.focusable || node.selected) return true;
  return Boolean(node.resourceId?.trim() && node.children.length === 0 && !STRUCTURAL_CLASS_PATTERN.test(node.className ?? ""));
}

function usesTextOnlyTexture(record: LayerRecord) {
  return Boolean(record.node.text?.trim() && TEXT_ONLY_CLASS_PATTERN.test(record.node.className ?? ""));
}

function isNearFullScreen(record: LayerRecord, size: PixelSize) {
  const width = record.renderBounds.right - record.renderBounds.left;
  const height = record.renderBounds.bottom - record.renderBounds.top;
  const widthRatio = width / size.width;
  const heightRatio = height / size.height;
  return (widthRatio >= 0.9 && heightRatio >= 0.75) || (widthRatio >= 0.75 && heightRatio >= 0.9);
}

function layerPlaneRoles(records: readonly LayerRecord[], size: PixelSize, hiddenNodeIds?: ReadonlySet<string>) {
  const roles = new Map<string, LayerPlaneRole>();
  for (const record of records) {
    roles.set(record.id, hasOwnVisualStyle(record, size, hiddenNodeIds) ? "surface" : "outline");
  }
  return roles;
}

function scaledRect(record: LayerRecord, renderScale: number, origin: Pick<Rect, "left" | "top">): Rect {
  const { left, top, right, bottom } = record.renderBounds;
  return { left: origin.left + left * renderScale, top: origin.top + top * renderScale, width: Math.max(1, (right - left) * renderScale), height: Math.max(1, (bottom - top) * renderScale) };
}

function sourceRect(record: LayerRecord): Rect {
  const { left, top, right, bottom } = record.renderBounds;
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function visualFor(record: LayerRecord, screenshotSize: PixelSize, visibilityKey: string) {
  if (record.isCollapsed) {
    const rect = sourceRect(record);
    const textureSize = { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
    return { kind: "composite" as const, textureSrc: `subtree:${record.id}:${visibilityKey}`, textureSize, source: { left: 0, top: 0, ...textureSize } };
  }
  if (record.node.layerImageDataUrl && record.node.layerImageSize) {
    const textureSize = record.node.layerImageSize;
    const bounds = record.sourceBounds;
    const scaleX = textureSize.width / (bounds.right - bounds.left);
    const scaleY = textureSize.height / (bounds.bottom - bounds.top);
    const rect = sourceRect(record);
    return { kind: "native" as const, textureSrc: record.node.layerImageDataUrl, textureSize, source: { left: (rect.left - bounds.left) * scaleX, top: (rect.top - bounds.top) * scaleY, width: rect.width * scaleX, height: rect.height * scaleY } };
  }
  return { kind: "isolated" as const, textureSrc: null, textureSize: screenshotSize, source: sourceRect(record) };
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}

function createRenderer(canvas: HTMLCanvasElement): Renderer | null {
  const gl = canvas.getContext("webgl", { alpha: true, antialias: true, powerPreference: "high-performance" });
  if (!gl) {
    canvas.dataset.layerWebglError = "context";
    return null;
  }
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!vertex || !fragment) {
    canvas.dataset.layerWebglError = "shader";
    return null;
  }
  const program = gl.createProgram();
  if (!program) {
    canvas.dataset.layerWebglError = "program";
    return null;
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    canvas.dataset.layerWebglError = "link";
    return null;
  }
  const quadBuffer = gl.createBuffer();
  const lineBuffer = gl.createBuffer();
  const texture = gl.createTexture();
  const unitLocation = gl.getAttribLocation(program, "a_unit");
  const uniformNames = ["u_rect", "u_source_rect", "u_viewport", "u_pivot", "u_depth", "u_distance", "u_rotation", "u_roll", "u_texture", "u_color", "u_rect_size", "u_kind", "u_opacity"];
  const uniforms = Object.fromEntries(uniformNames.map((name) => [name, gl.getUniformLocation(program, name)])) as Record<string, WebGLUniformLocation | null>;
  if (!quadBuffer || !lineBuffer || !texture || unitLocation < 0 || Object.values(uniforms).some((location) => !location)) {
    gl.deleteBuffer(quadBuffer);
    gl.deleteBuffer(lineBuffer);
    gl.deleteTexture(texture);
    gl.deleteProgram(program);
    canvas.dataset.layerWebglError = "bindings";
    return null;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { canvas, gl, program, quadBuffer, lineBuffer, texture, layerTextures: new Map(), layerTextureBytes: new Map(), unitLocation, uniforms: uniforms as Record<string, WebGLUniformLocation>, textureReady: false, cssWidth: 0, cssHeight: 0, renderVersion: 0 };
}

function disposeRenderer(renderer: Renderer) {
  const { gl } = renderer;
  gl.deleteBuffer(renderer.quadBuffer);
  gl.deleteBuffer(renderer.lineBuffer);
  gl.deleteTexture(renderer.texture);
  for (const texture of renderer.layerTextures.values()) gl.deleteTexture(texture);
  gl.deleteProgram(renderer.program);
}

function resizeRenderer(renderer: Renderer) {
  const width = Math.max(1, renderer.canvas.clientWidth);
  const height = Math.max(1, renderer.canvas.clientHeight);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / (width * height)));
  const backingWidth = Math.max(1, Math.round(width * pixelRatio));
  const backingHeight = Math.max(1, Math.round(height * pixelRatio));
  renderer.cssWidth = width;
  renderer.cssHeight = height;
  if (renderer.canvas.width === backingWidth && renderer.canvas.height === backingHeight) return;
  renderer.canvas.width = backingWidth;
  renderer.canvas.height = backingHeight;
}

function uploadTexture(renderer: Renderer, image: HTMLImageElement) {
  const { gl } = renderer;
  gl.bindTexture(gl.TEXTURE_2D, renderer.texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  while (gl.getError() !== gl.NO_ERROR) { /* clear setup errors before texture upload */ }
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  const error = gl.getError();
  renderer.textureReady = error === gl.NO_ERROR;
  if (!renderer.textureReady) renderer.canvas.dataset.layerWebglError = `texture-${error}`;
  return renderer.textureReady;
}

function uploadLayerTexture(renderer: Renderer, src: string, image: ImageBitmap | HTMLCanvasElement, maxPixels: number) {
  const { gl } = renderer;
  const size = textureDimensions(image.width, image.height, maxPixels, gl.getParameter(gl.MAX_TEXTURE_SIZE));
  let resized: HTMLCanvasElement | null = null;
  if (size.width !== image.width || size.height !== image.height) {
    resized = document.createElement("canvas");
    resized.width = size.width; resized.height = size.height;
    const context = resized.getContext("2d");
    if (!context) return false;
    context.drawImage(image, 0, 0, size.width, size.height);
  }
  const texture = gl.createTexture();
  if (!texture) return false;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, resized ?? image);
  if (resized) resized.width = resized.height = 0;
  if (gl.getError() !== gl.NO_ERROR) {
    gl.deleteTexture(texture);
    return false;
  }
  gl.deleteTexture(renderer.layerTextures.get(src) ?? null);
  renderer.layerTextures.set(src, texture);
  renderer.layerTextureBytes.set(src, size.width * size.height * 4);
  return true;
}

async function loadLayerImage(src: string) {
  const image = new Image();
  image.src = src;
  try { await image.decode(); return await createImageBitmap(image, { premultiplyAlpha: "none" }); }
  finally { image.src = ""; }
}

function rotatePoint(x: number, y: number, z: number, pivot: ScenePivot, camera: LayerCamera) {
  const yaw = radians(-camera.azimuth);
  const pitch = radians(-camera.elevation);
  const roll = radians(-camera.roll);
  const centeredX = x - pivot.x;
  const centeredY = pivot.y - y;
  const centeredZ = z - pivot.z;
  const xYaw = Math.cos(yaw) * centeredX + Math.sin(yaw) * centeredZ;
  const zYaw = -Math.sin(yaw) * centeredX + Math.cos(yaw) * centeredZ;
  const yPitch = Math.cos(pitch) * centeredY - Math.sin(pitch) * zYaw;
  const zPitch = Math.sin(pitch) * centeredY + Math.cos(pitch) * zYaw;
  const xRoll = Math.cos(roll) * xYaw - Math.sin(roll) * yPitch;
  const yRoll = Math.sin(roll) * xYaw + Math.cos(roll) * yPitch;
  return { x: xRoll, y: yRoll, depth: zPitch };
}

function projectPoint(x: number, y: number, z: number, pivot: ScenePivot, camera: LayerCamera) {
  const point = rotatePoint(x, y, z, pivot, camera);
  const scale = camera.distance / Math.max(1, camera.distance - point.depth);
  return { x: pivot.x + point.x * scale, y: pivot.y - point.y * scale, depth: point.depth };
}

function projectPlane(plane: ScenePlane, pivot: ScenePivot, camera: LayerCamera) {
  const { left, top, width: planeWidth, height: planeHeight } = plane.rect;
  const corners = [
    projectPoint(left, top, plane.z, pivot, camera),
    projectPoint(left + planeWidth, top, plane.z, pivot, camera),
    projectPoint(left + planeWidth, top + planeHeight, plane.z, pivot, camera),
    projectPoint(left, top + planeHeight, plane.z, pivot, camera),
  ];
  return { corners, depth: corners.reduce((sum, point) => sum + point.depth, 0) / corners.length };
}

function pointInQuad(point: Point, corners: readonly Point[]) {
  let hasPositive = false;
  let hasNegative = false;
  for (let index = 0; index < corners.length; index += 1) {
    const start = corners[index];
    const end = corners[(index + 1) % corners.length];
    const cross = (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
    hasPositive ||= cross > 0.1;
    hasNegative ||= cross < -0.1;
    if (hasPositive && hasNegative) return false;
  }
  return true;
}

function measurementLabel(measurement: BoundsMeasurement, index: number) {
  if (measurement.relation === "equal") return "边界重合 · 间距 0 px";
  if (measurement.relation === "overlap") return "外框重叠 · 间距 0 px";
  if (measurement.relation === "touching") return "边缘相接 · 间距 0 px";
  return measurement.guides[index].distances.map(({ label, value }) => `${label} ${Number(value.toFixed(2))} px`).join(" · ");
}

function drawScene(renderer: Renderer, planes: readonly ScenePlane[], camera: LayerCamera, pivot: ScenePivot, projectedRef: { current: ProjectedPlane[] }) {
  resizeRenderer(renderer);
  const { gl, canvas } = renderer;
  if (!renderer.textureReady || !renderer.cssWidth || !renderer.cssHeight) return;
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(renderer.program);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.activeTexture(gl.TEXTURE0);
  gl.uniform1i(renderer.uniforms.u_texture, 0);
  gl.uniform2f(renderer.uniforms.u_viewport, renderer.cssWidth, renderer.cssHeight);
  gl.uniform3f(renderer.uniforms.u_pivot, pivot.x, pivot.y, pivot.z);
  gl.uniform1f(renderer.uniforms.u_distance, Math.max(1, camera.distance));
  const yaw = radians(-camera.azimuth);
  const pitch = radians(-camera.elevation);
  const roll = radians(-camera.roll);
  gl.uniform4f(renderer.uniforms.u_rotation, Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch));
  gl.uniform2f(renderer.uniforms.u_roll, Math.cos(roll), Math.sin(roll));
  const highlightRank = (kind: RenderKind) => kind === "hover" ? 2 : kind === "selection" ? 1 : 0;
  const ordered = planes.map((plane) => ({ plane, projected: projectPlane(plane, pivot, camera) })).sort((left, right) => {
    const depth = left.projected.depth - right.projected.depth;
    return depth || highlightRank(left.plane.kind) - highlightRank(right.plane.kind);
  });
  projectedRef.current = ordered
    .filter(({ plane }) => plane.hitTestable && plane.node)
    .map(({ plane, projected }) => ({ node: plane.node!, corners: projected.corners, depth: projected.depth }))
    .sort((left, right) => right.depth - left.depth);
  let probe: Point | null = null;
  for (const plane of projectedRef.current) {
    const x = plane.corners.reduce((sum, point) => sum + point.x, 0) / plane.corners.length;
    const y = plane.corners.reduce((sum, point) => sum + point.y, 0) / plane.corners.length;
    if (x >= 0 && x <= renderer.cssWidth && y >= 0 && y <= renderer.cssHeight) {
      probe = { x, y };
      break;
    }
  }
  if (probe) {
    canvas.dataset.layerProbeX = String(probe.x);
    canvas.dataset.layerProbeY = String(probe.y);
  } else {
    delete canvas.dataset.layerProbeX;
    delete canvas.dataset.layerProbeY;
  }
  for (const { plane } of ordered) {
    const texture = plane.textureSrc === null || plane.textureSrc === "" ? renderer.texture : renderer.layerTextures.get(plane.textureSrc);
    const missingTexture = (plane.kind === "native" || plane.kind === "composite" || plane.kind === "isolated") && !texture;
    const renderKind = missingTexture ? "outline" : plane.kind;
    gl.bindTexture(gl.TEXTURE_2D, texture ?? renderer.texture);
    const color = renderKind === "selection" ? SELECTION_COLOR : renderKind === "hover" ? HOVER_COLOR : OUTLINE_COLOR;
    const kind = renderKind === "native" || renderKind === "composite" ? 1 : renderKind === "isolated" ? 2 : renderKind === "outline" ? 3 : renderKind === "selection" ? 4 : 5;
    gl.uniform4f(renderer.uniforms.u_rect, plane.rect.left, plane.rect.top, plane.rect.width, plane.rect.height);
    gl.uniform4f(renderer.uniforms.u_source_rect, plane.source.left / plane.textureSize.width, plane.source.top / plane.textureSize.height, plane.source.width / plane.textureSize.width, plane.source.height / plane.textureSize.height);
    gl.uniform1f(renderer.uniforms.u_depth, plane.z);
    gl.uniform4f(renderer.uniforms.u_color, color[0], color[1], color[2], 1);
    gl.uniform2f(renderer.uniforms.u_rect_size, plane.rect.width, plane.rect.height);
    gl.uniform1f(renderer.uniforms.u_kind, kind);
    gl.uniform1f(renderer.uniforms.u_opacity, missingTexture ? 0.82 : plane.opacity);
    const isLine = renderKind === "outline";
    gl.bindBuffer(gl.ARRAY_BUFFER, isLine ? renderer.lineBuffer : renderer.quadBuffer);
    gl.enableVertexAttribArray(renderer.unitLocation);
    gl.vertexAttribPointer(renderer.unitLocation, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(isLine ? gl.LINE_LOOP : gl.TRIANGLES, 0, isLine ? 4 : 6);
  }
  renderer.renderVersion += 1;
  canvas.dataset.layerRenderVersion = String(renderer.renderVersion);
  canvas.dataset.layerCanvasPixels = `${canvas.width}x${canvas.height}`;
}

export const Layer3DPreview = forwardRef<LayerSceneHandle, Props>(function Layer3DPreview({ src, root, selectedNode, expandedNodeIds, hiddenNodeIds = NO_HIDDEN_NODES, size, renderScale, origin, camera, onSelect, onFitScale }, ref) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const cameraRef = useRef(camera);
  const planesRef = useRef<ScenePlane[]>([]);
  const projectedRef = useRef<ProjectedPlane[]>([]);
  const measureGuideRefs = useRef<Array<SVGGElement | null>>([]);
  const hoverLabelRef = useRef<HTMLDivElement>(null);
  const hoverPointRef = useRef<Point | null>(null);
  const drawRef = useRef<() => void>(() => {});
  const fitRef = useRef<() => void>(() => {});
  const [rendererStatus, setRendererStatus] = useState<RendererStatus>("loading");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [textureWarning, setTextureWarning] = useState<string | null>(null);
  const layout = useMemo(() => buildLayerOverview(root, selectedNode, size, { maxLayers: 512, layerGap: camera.layerGap, expandedIds: expandedNodeIds }), [camera.layerGap, expandedNodeIds, root, selectedNode, size]);
  // Hide presentation only: retain the original Z slots and camera pivot.
  const records = useMemo(() => layout.records.filter((record) => !hiddenNodeIds.has(record.id)), [layout.records, hiddenNodeIds]);
  const parent = layout.parent && !hiddenNodeIds.has(layout.parent.id) ? layout.parent : null;
  const visibilityKey = useMemo(() => JSON.stringify([...hiddenNodeIds].sort()), [hiddenNodeIds]);
  const textureRecords = [parent, ...records].filter((record): record is LayerRecord => Boolean(record && hasOwnVisualStyle(record, size, hiddenNodeIds) && (record.isCollapsed || record.node.layerImageDataUrl)));
  // Camera/hover changes don't change the required images or restart decoding.
  const textureKey = `${visibilityKey}|${textureRecords.map((record) => `${record.id}:${record.isCollapsed}`).join("|")}`;
  const roles = useMemo(() => layerPlaneRoles(records, size, hiddenNodeIds), [records, size, hiddenNodeIds]);
  const selectedRecord = records.find((record) => record.isSelected) ?? (parent?.isSelected ? parent : null);
  const hoveredRecord = records.find((record) => record.id === hoveredId) ?? (parent?.id === hoveredId ? parent : null);
  const measurement = useMemo(() => selectedRecord && hoveredRecord && selectedRecord.id !== hoveredRecord.id && rendererStatus === "webgl"
    ? measureBounds(selectedRecord.sourceBounds, hoveredRecord.sourceBounds) : null, [selectedRecord, hoveredRecord, rendererStatus]);
  const parentRole = parent ? (hasOwnVisualStyle(parent, size, hiddenNodeIds) ? "surface" : "outline") : null;
  const textureCount = records.filter((record) => roles.get(record.id) === "surface").length + Number(parentRole === "surface");
  const compositeCount = records.filter((record) => record.isCollapsed).length + Number(Boolean(parent?.isCollapsed));
  const nativeTextureCount = records.filter((record) => roles.get(record.id) === "surface" && Boolean(record.node.layerImageDataUrl)).length;
  const textOnlyCount = records.filter((record) => roles.get(record.id) === "surface" && usesTextOnlyTexture(record)).length;
  const outlineCount = records.filter((record) => roles.get(record.id) === "outline").length;
  const sceneRecords = [layout.parent, ...layout.records].filter((record): record is LayerRecord => Boolean(record));
  const center = {
    x: sceneRecords.length ? (Math.min(...sceneRecords.map(r => r.renderBounds.left)) + Math.max(...sceneRecords.map(r => r.renderBounds.right))) / 2 : size.width / 2,
    y: sceneRecords.length ? (Math.min(...sceneRecords.map(r => r.renderBounds.top)) + Math.max(...sceneRecords.map(r => r.renderBounds.bottom))) / 2 : size.height / 2,
    z: sceneRecords.length ? (Math.min(...sceneRecords.map(r => r.z)) + Math.max(...sceneRecords.map(r => r.z))) / 2 : 0,
  };
  const renderOrigin = { left: origin.left + (size.width / 2 - center.x) * renderScale, top: origin.top + (size.height / 2 - center.y) * renderScale };
  const pivot = useMemo(() => ({
    x: origin.left + size.width * renderScale / 2,
    y: origin.top + size.height * renderScale / 2,
    z: center.z * renderScale,
  }), [origin.left, origin.top, size.width, size.height, center.z, renderScale]);

  fitRef.current = () => {
    const canvas = canvasRef.current;
    if (!onFitScale || !canvas?.clientWidth || !canvas.clientHeight) return;
    const currentCamera = cameraRef.current;
    const halfWidth = canvas.clientWidth * 0.43, halfHeight = canvas.clientHeight * 0.43;
    const distance = currentCamera.distance;
    let scale = 1;
    // Fit every actual corner, including Z, with a 7% margin on each side.
    // Solve the perspective inequality directly; no trial renders or zoom loop.
    for (const record of sceneRecords) {
      const b = record.renderBounds;
      for (const x of [b.left, b.right]) for (const y of [b.top, b.bottom]) {
        const p = rotatePoint(x, y, record.z, center, currentCamera);
        for (const [extent, half] of [[Math.abs(p.x), halfWidth], [Math.abs(p.y), halfHeight]]) {
          const denominator = distance * extent + half * p.depth;
          if (denominator > 0) scale = Math.min(scale, half * distance / denominator);
        }
        if (p.depth > 0) scale = Math.min(scale, (distance - 32) / p.depth);
      }
    }
    onFitScale(scale);
  };

  useEffect(() => {
    if (hoveredId && !hoveredRecord) setHoveredId(null);
  }, [hoveredId, hoveredRecord]);

  useEffect(() => { setHoveredId(null); }, [root, src]);

  const scenePlanes = useMemo(() => {
    // Each visible plane owns its pixels. A full-screen screenshot behind the
    // stack duplicates child content and reads like a reflected surface.
    const planes: ScenePlane[] = [];
    if (parent) {
      const visual = parentRole === "surface" ? visualFor(parent, size, visibilityKey) : null;
      planes.push({ id: `${parent.id}:parent`, node: parent.hitTestable ? parent.node : null, rect: scaledRect(parent, renderScale, renderOrigin), source: visual?.source ?? sourceRect(parent), textureSrc: visual?.textureSrc ?? null, textureSize: visual?.textureSize ?? size, z: parent.z * renderScale, kind: visual?.kind ?? "outline", opacity: parentRole === "surface" ? (parent.isCollapsed ? 1 : Number(parent.node.attributes?.["effective-alpha"] ?? 1)) : 0.45, hitTestable: parent.hitTestable });
    }
    for (const record of records) {
      const role = roles.get(record.id) ?? "outline";
      const visual = role === "surface" ? visualFor(record, size, visibilityKey) : null;
      planes.push({ id: record.id, node: record.node, rect: scaledRect(record, renderScale, renderOrigin), source: visual?.source ?? sourceRect(record), textureSrc: visual?.textureSrc ?? null, textureSize: visual?.textureSize ?? size, z: record.z * renderScale, kind: visual?.kind ?? "outline", opacity: role === "outline" ? (record.isCompact ? 0.16 : 0.5) : record.isCollapsed ? 1 : Number(record.node.attributes?.["effective-alpha"] ?? 1), hitTestable: record.hitTestable });
    }
    if (selectedRecord) planes.push({ id: `${selectedRecord.id}:selection`, node: null, rect: scaledRect(selectedRecord, renderScale, renderOrigin), source: sourceRect(selectedRecord), textureSrc: null, textureSize: size, z: selectedRecord.z * renderScale, kind: "selection", opacity: 1, hitTestable: false });
    if (hoveredRecord && !hoveredRecord.isSelected) planes.push({ id: `${hoveredRecord.id}:hover`, node: null, rect: scaledRect(hoveredRecord, renderScale, renderOrigin), source: sourceRect(hoveredRecord), textureSrc: null, textureSize: size, z: hoveredRecord.z * renderScale, kind: "hover", opacity: 1, hitTestable: false });
    return planes;
  }, [hoveredRecord, parent, renderOrigin.left, renderOrigin.top, parentRole, records, renderScale, roles, selectedRecord, size, visibilityKey]);

  drawRef.current = () => {
    positionHoverLabel();
    const renderer = rendererRef.current;
    if (!renderer) return;
    const currentCamera = cameraRef.current;
    drawScene(renderer, planesRef.current, currentCamera, pivot, projectedRef);
    if (!measurement || !selectedRecord || !hoveredRecord) return;
    // At most four SVG guides. Reproject with the existing camera paint path;
    // do not render React or rebuild GPU textures on each orbit frame.
    const widths = measureGuideRefs.current.map(group => group?.querySelector("text")?.getComputedTextLength() ?? 0);
    const labels: Array<{ x: number; y: number; width: number }> = [];
    measurement.guides.forEach((guide, index) => {
      const group = measureGuideRefs.current[index];
      if (!group) return;
      const from = projectPoint(renderOrigin.left + guide.from.x * renderScale, renderOrigin.top + guide.from.y * renderScale, selectedRecord.z * renderScale, pivot, currentCamera);
      const to = projectPoint(renderOrigin.left + guide.to.x * renderScale, renderOrigin.top + guide.to.y * renderScale, hoveredRecord.z * renderScale, pivot, currentCamera);
      const visible = from.depth < currentCamera.distance - 1 && to.depth < currentCamera.distance - 1 && [from.x, from.y, to.x, to.y].every(Number.isFinite);
      group.style.visibility = visible ? "visible" : "hidden";
      if (!visible) return;
      group.querySelector("path")!.setAttribute("d", `M ${from.x} ${from.y} L ${to.x} ${to.y}`);
      for (const [i, point] of [from, to].entries()) {
        const dot = group.querySelectorAll("circle")[i];
        dot.setAttribute("cx", String(point.x)); dot.setAttribute("cy", String(point.y));
      }
      const width = widths[index] + 16;
      // Labels stay readable at the viewport edge even after panning.
      const minX = Math.max(0, -currentCamera.panX) + 8, maxX = Math.min(renderer.cssWidth, renderer.cssWidth - currentCamera.panX) - width - 8;
      const minY = Math.max(0, -currentCamera.panY) + 8, maxY = Math.min(renderer.cssHeight, renderer.cssHeight - currentCamera.panY) - 32;
      if (minX > maxX || minY > maxY) { group.style.visibility = "hidden"; return; }
      const x = Math.max(minX, Math.min(maxX, (from.x + to.x - width) / 2));
      let y = Math.max(minY, Math.min(maxY, (from.y + to.y) / 2 - 30));
      for (const offset of [0, 28, -28, 56, -56, 84, -84, 112, -112]) {
        const candidate = Math.max(minY, Math.min(maxY, y + offset));
        if (labels.every(previous => x >= previous.x + previous.width + 4 || x + width + 4 <= previous.x || Math.abs(candidate - previous.y) >= 28)) {
          y = candidate; break;
        }
      }
      labels.push({ x, y, width });
      group.querySelector("g")!.setAttribute("transform", `translate(${x} ${y})`);
      group.querySelector("rect")!.setAttribute("width", String(width));
    });
  };

  useEffect(() => {
    planesRef.current = scenePlanes;
    drawRef.current();
  }, [scenePlanes]);

  useEffect(() => {
    drawRef.current();
  }, [pivot]);

  useEffect(() => {
    cameraRef.current = camera;
    sceneRef.current?.style.setProperty("transform", `translate3d(${camera.panX}px, ${camera.panY}px, 0)`);
    drawRef.current();
  }, [camera]);

  // Fit after updating the camera. Selection, hover, hiding and free rotation
  // do not change framing; a changed tree, spacing or viewport does.
  useEffect(() => { fitRef.current(); }, [root, expandedNodeIds, camera.layerGap, camera.distance]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = createRenderer(canvas);
    if (!renderer) {
      setRendererStatus("fallback");
      return;
    }
    let alive = true;
    rendererRef.current = renderer;
    const observer = new ResizeObserver(() => { fitRef.current(); drawRef.current(); });
    observer.observe(canvas);
    const onContextLost = (event: Event) => {
      event.preventDefault();
      projectedRef.current = [];
      rendererRef.current = null;
      if (alive) setRendererStatus("fallback");
    };
    canvas.addEventListener("webglcontextlost", onContextLost);
    const image = new Image();
    image.onload = () => {
      if (!alive || rendererRef.current !== renderer || !uploadTexture(renderer, image)) {
        if (alive) setRendererStatus("fallback");
        return;
      }
      setRendererStatus("webgl");
      drawRef.current();
    };
    image.onerror = () => { if (alive) setRendererStatus("fallback"); };
    image.src = src;
    return () => {
      alive = false;
      observer.disconnect();
      canvas.removeEventListener("webglcontextlost", onContextLost);
      if (rendererRef.current === renderer) rendererRef.current = null;
      disposeRenderer(renderer);
    };
  }, [root, src]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    let alive = true;
    const wanted = new Map(textureRecords.map((record) => [record.isCollapsed ? `subtree:${record.id}:${visibilityKey}` : record.node.layerImageDataUrl!, record]));
    const maxPixels = Math.min(2_000_000, Math.floor(MAX_LAYER_TEXTURE_PIXELS / Math.max(1, wanted.size)));
    setTextureWarning(null);
    for (const [key, texture] of renderer.layerTextures) {
      if (wanted.has(key) && (renderer.layerTextureBytes.get(key) ?? 0) <= maxPixels * 4) continue;
      renderer.gl.deleteTexture(texture);
      renderer.layerTextures.delete(key);
      renderer.layerTextureBytes.delete(key);
    }
    const load = async (node: UiNode) => {
      if (!alive) throw new Error("图层加载已取消");
      const image = await loadLayerImage(node.layerImageDataUrl!);
      if (!alive) { image.close(); throw new Error("图层加载已取消"); }
      return image;
    };
    // Decode serially: a folded branch may contain hundreds of full-size PNGs.
    void (async () => {
      for (const [key, record] of wanted) {
        if (!alive || rendererRef.current !== renderer) return;
        if (renderer.layerTextures.has(key)) continue;
        let image: ImageBitmap | HTMLCanvasElement | null = null;
        try {
          image = record.isCollapsed
            ? await composeSubtreeImage(record.node, sourceRect(record), load, maxPixels, hiddenNodeIds)
            : await load(record.node);
          if (!alive || rendererRef.current !== renderer) return;
          if (!uploadLayerTexture(renderer, key, image, maxPixels)) throw new Error("图层纹理上传失败");
          drawRef.current();
        } catch (error) {
          if (alive) setTextureWarning(error instanceof Error ? error.message : "部分图层未能加载");
        } finally {
          if (image instanceof ImageBitmap) image.close();
          else if (image) image.width = image.height = 0;
        }
      }
      if (!alive || rendererRef.current !== renderer) return;
      renderer.canvas.dataset.layerTextureBytes = String([...renderer.layerTextureBytes.values()].reduce((sum, value) => sum + value, 0));
      renderer.canvas.dataset.layerTextureCount = String(renderer.layerTextures.size);
      renderer.canvas.dataset.layerTextureVisibility = visibilityKey;
    })();
    return () => { alive = false; };
  }, [textureKey, rendererStatus, root]);

  function pickNode(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    if (!canvas || rendererStatus !== "webgl") return null;
    const rect = canvas.getBoundingClientRect();
    const point = { x: clientX - rect.left, y: clientY - rect.top };
    if (point.x < 0 || point.y < 0 || point.x >= rect.width || point.y >= rect.height) return null;
    return projectedRef.current.find((plane) => pointInQuad(point, plane.corners))?.node ?? null;
  }

  function positionHoverLabel() {
    const label = hoverLabelRef.current, canvas = canvasRef.current, point = hoverPointRef.current;
    if (!label || !canvas || !point) return;
    const rect = canvas.getBoundingClientRect();
    const viewport = canvas.closest(".screenshot-frame")?.getBoundingClientRect() ?? rect;
    const minX = Math.max(0, viewport.left - rect.left) + 8, minY = Math.max(0, viewport.top - rect.top) + 8;
    const maxX = Math.min(rect.width, viewport.right - rect.left) - label.offsetWidth - 8;
    const maxY = Math.min(rect.height, viewport.bottom - rect.top) - label.offsetHeight - 8;
    const x = point.x - rect.left, y = point.y - rect.top;
    label.style.transform = `translate(${Math.max(minX, Math.min(maxX, x + 14 > maxX ? x - label.offsetWidth - 14 : x + 14))}px, ${Math.max(minY, Math.min(maxY, y + 18 > maxY ? y - label.offsetHeight - 18 : y + 18))}px)`;
  }

  useImperativeHandle(ref, () => ({
    paintCamera(next) {
      cameraRef.current = next;
      sceneRef.current?.style.setProperty("transform", `translate3d(${next.panX}px, ${next.panY}px, 0)`);
      drawRef.current();
    },
    fit() { fitRef.current(); },
    pick: pickNode,
    hover(clientX, clientY) {
      const nextId = pickNode(clientX, clientY)?.id ?? null;
      hoverPointRef.current = { x: clientX, y: clientY };
      positionHoverLabel();
      setHoveredId((current) => current === nextId ? current : nextId);
    },
    clearHover() {
      hoverPointRef.current = null;
      setHoveredId((current) => current ? null : current);
    },
  }), [rendererStatus]);

  return (
    <div ref={sceneRef} className={`layer-scene layer-renderer-${rendererStatus}`} style={{ transform: `translate3d(${camera.panX}px, ${camera.panY}px, 0)` }} data-view-mode="layers3d" data-layer-mode="overview" data-layer-parent-id={layout.parentId ?? ""} data-layer-hovered-id={hoveredId ?? ""} data-layer-hidden-count={hiddenNodeIds.size} data-layer-count={records.length + Number(Boolean(parent?.isCollapsed))} data-layer-texture-count={textureCount} data-layer-native-texture-count={nativeTextureCount} data-layer-composite-count={compositeCount} data-layer-root-composite={parent?.isCollapsed ? "true" : "false"} data-layer-text-only-count={textOnlyCount} data-layer-outline-count={outlineCount} data-layer-selection-count={Number(Boolean(selectedRecord))} data-layer-candidate-count={layout.candidateCount} data-layer-truncated={layout.truncated ? "true" : "false"} data-layer-omitted-count={layout.omittedCount} data-layer-pivot-x={pivot.x.toFixed(2)} data-layer-pivot-y={pivot.y.toFixed(2)} data-layer-pivot-z={pivot.z.toFixed(2)} aria-label="WebGL 3D hierarchy layers">
      <canvas ref={canvasRef} className="layer-webgl-canvas" data-layer-webgl="true" data-layer-renderer={rendererStatus} aria-hidden="true" />
      {hoveredRecord && rendererStatus === "webgl" && <div ref={hoverLabelRef} className={`layer-hover-label${hoveredRecord.isSelected ? " is-selected" : ""}`} role="tooltip" data-node-id={hoveredRecord.id}>
        <div><span>{hoveredRecord.isSelected ? "已选中" : "指向"}</span><strong>{nodeShortClass(hoveredRecord.node)}</strong></div>
        <code>{hoveredRecord.node.resourceId?.replace(/^.*:id\//, "@id/") || hoveredRecord.node.text || hoveredRecord.node.contentDesc || `#${hoveredRecord.id}`}</code>
      </div>}
      {measurement && <>
        <svg className="layer-measurement" aria-hidden="true" data-measure-anchor={selectedRecord!.id} data-measure-target={hoveredRecord!.id} data-measure-relation={measurement.relation}>
          {measurement.guides.map((_guide, index) => <g key={index} ref={element => { measureGuideRefs.current[index] = element; }}>
            <path /><circle r="3" className="measure-anchor" /><circle r="3" className="measure-target" />
            <g className="measure-label"><rect height="24" rx="4" /><text x="8" y="16">{measurementLabel(measurement, index)}</text></g>
          </g>)}
        </svg>
        <span className="layer-measurement-status" role="status">{nodeDisplayLabel(selectedRecord!.node)} 到 {nodeDisplayLabel(hoveredRecord!.node)}：{measurement.guides.map((_, index) => measurementLabel(measurement, index)).join("，")}。按原始外框测量，不含 3D 展开层距。</span>
      </>}
      {rendererStatus === "fallback" && <span className="layer-webgl-fallback">WebGL 不可用，已回退到截图预览。</span>}
      {(layout.truncated || textureWarning) && <span className="layer-resource-note" role="status">{textureWarning ?? `当前显示 ${records.length} 层，另有 ${layout.omittedCount} 层未显示；可收起分支或从树中选中定位。`}</span>}
      <div className="layer-scene-metadata" hidden aria-hidden="true">
        {records.map((record) => {
          const role = roles.get(record.id) ?? "outline";
          const textOnly = role === "surface" && usesTextOnlyTexture(record);
          return <button className={`layer-plane ${role} ${record.isSelected ? "selected" : ""}`} data-layer-node-id={record.id} data-layer-depth={record.depth} data-layer-z={record.z} data-layer-z-order={record.zOrder} data-layer-z-order-source={record.zOrderSource} data-layer-selected={record.isSelected ? "true" : "false"} data-layer-role={role} data-layer-texture={role === "surface" ? "true" : "false"} data-layer-texture-mode={role === "surface" ? (record.isCollapsed ? "composite" : record.node.layerImageDataUrl ? "native" : "isolated") : "none"} data-layer-content={textOnly ? "text" : role === "surface" ? "control" : "structure"} data-layer-expanded-parent={record.node.children.length > 0 && !record.isCollapsed ? "true" : "false"} data-layer-focus={record.isSelected ? "true" : "false"} data-layer-hit-testable={record.hitTestable ? "true" : "false"} key={record.id} type="button" tabIndex={-1} onClick={() => onSelect(record.node)} />;
        })}
      </div>
    </div>
  );
});

Layer3DPreview.displayName = "Layer3DPreview";
