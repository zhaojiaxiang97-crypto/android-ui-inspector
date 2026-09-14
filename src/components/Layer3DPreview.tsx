import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { PixelSize, UiNode } from "../../shared/types";
import { buildLayerOverview, type LayerRecord } from "../../shared/layer-layout";

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
  pick: (clientX: number, clientY: number) => UiNode | null;
  hover: (clientX: number, clientY: number) => void;
  clearHover: () => void;
};

type Props = {
  src: string;
  root: UiNode;
  selectedNode: UiNode | null;
  expandedNodeIds: ReadonlySet<string>;
  size: PixelSize;
  renderScale: number;
  origin: Pick<Rect, "left" | "top">;
  camera: LayerCamera;
  onSelect: (node: UiNode) => void;
};

type LayerPlaneRole = "surface" | "outline";
type RenderKind = "base" | "texture" | "text" | "outline" | "selection" | "hover";
type Rect = { left: number; top: number; width: number; height: number };
type ScenePlane = { id: string; node: UiNode | null; rect: Rect; source: Rect; z: number; kind: RenderKind; opacity: number; hitTestable: boolean };
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
  unitLocation: number;
  uniforms: Record<string, WebGLUniformLocation>;
  textureReady: boolean;
  cssWidth: number;
  cssHeight: number;
  renderVersion: number;
};

const MAX_CANVAS_PIXELS = 4_000_000;
const CONTENT_CLASS_PATTERN = /(TextView|ImageView|ImageButton|Button|EditText|CheckBox|RadioButton|Switch|ToggleButton|ProgressBar|SeekBar|WebView|SurfaceView|TextureView|VideoView)/i;
const STRUCTURAL_CLASS_PATTERN = /(FrameLayout|LinearLayout|RelativeLayout|ConstraintLayout|ViewGroup|ViewPager|SlidingPaneLayout|RecyclerView|ScrollView|DrawerLayout|CoordinatorLayout)/i;
const FOREGROUND_MASK_CLASS_PATTERN = /(TextView|Button|ImageButton|EditText|CheckBox|RadioButton|Switch|ToggleButton|ProgressBar|SeekBar)$/i;
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
    float perspective = u_distance / max(1.0, u_distance - z_pitch);
    float projected_x = u_pivot.x + x_roll * perspective;
    float projected_y = u_pivot.y - y_roll * perspective;
    gl_Position = vec4(projected_x / (u_viewport.x * 0.5) - 1.0, 1.0 - projected_y / (u_viewport.y * 0.5), 0.0, 1.0);
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
    if (u_kind < 0.5) {
      vec4 source = texture2D(u_texture, v_source);
      vec3 shaded = mix(source.rgb, vec3(0.10, 0.16, 0.15), 0.46);
      gl_FragColor = vec4(shaded, source.a * u_opacity);
      return;
    }
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
      float edge_distance = min(min(v_uv.x, v_uv.y), min(1.0 - v_uv.x, 1.0 - v_uv.y));
      float edge_size = min(0.20, 2.4 / max(1.0, min(u_rect_size.x, u_rect_size.y)));
      float edge = 1.0 - smoothstep(edge_size, edge_size * 1.8, edge_distance);
      gl_FragColor = vec4(u_color.rgb, edge * u_opacity);
      return;
    }
    gl_FragColor = vec4(u_color.rgb, u_opacity);
  }
`;

function radians(value: number) {
  return value * Math.PI / 180;
}

function hasOwnVisualStyle(record: LayerRecord, size: PixelSize) {
  const node = record.node;
  // ponytail: UIAutomator has no isolated view bitmap; texture only leaf views so parent/child pixels are not copied into each other.
  if (record.isVirtual || isNearFullScreen(record, size) || node.children.length > 0 || STRUCTURAL_CLASS_PATTERN.test(node.className ?? "")) return false;
  if (node.text?.trim() || node.contentDesc?.trim()) return true;
  if (CONTENT_CLASS_PATTERN.test(node.className ?? "")) return true;
  if (node.clickable || node.focusable || node.selected) return true;
  return Boolean(node.resourceId?.trim() && node.children.length === 0 && !STRUCTURAL_CLASS_PATTERN.test(node.className ?? ""));
}

function usesForegroundMask(record: LayerRecord) {
  const node = record.node;
  // ponytail: UIAutomator only supplies a composite screenshot; standard controls keep pixels unlike their local edge background, while media keeps its full image.
  return Boolean(FOREGROUND_MASK_CLASS_PATTERN.test(node.className ?? ""));
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

function isStructuralScreenContainer(record: LayerRecord, size: PixelSize) {
  if (!isNearFullScreen(record, size)) return false;
  // ponytail: bounds-only heuristic; use Android Solo/Group captures if independent render layers become available.
  return record.node.children.length > 0 || STRUCTURAL_CLASS_PATTERN.test(record.node.className ?? "");
}

function layerPlaneRoles(records: readonly LayerRecord[], size: PixelSize) {
  const roles = new Map<string, LayerPlaneRole>();
  for (const record of records) {
    roles.set(record.id, hasOwnVisualStyle(record, size) ? "surface" : "outline");
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
  return { canvas, gl, program, quadBuffer, lineBuffer, texture, unitLocation, uniforms: uniforms as Record<string, WebGLUniformLocation>, textureReady: false, cssWidth: 0, cssHeight: 0, renderVersion: 0 };
}

function disposeRenderer(renderer: Renderer) {
  const { gl } = renderer;
  gl.deleteBuffer(renderer.quadBuffer);
  gl.deleteBuffer(renderer.lineBuffer);
  gl.deleteTexture(renderer.texture);
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

function projectPoint(x: number, y: number, z: number, pivot: ScenePivot, camera: LayerCamera) {
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
  const scale = camera.distance / Math.max(1, camera.distance - zPitch);
  return { x: pivot.x + xRoll * scale, y: pivot.y - yRoll * scale, depth: zPitch };
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

function drawScene(renderer: Renderer, planes: readonly ScenePlane[], camera: LayerCamera, sourceSize: PixelSize, pivot: ScenePivot, projectedRef: { current: ProjectedPlane[] }) {
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
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, renderer.texture);
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
    const color = plane.kind === "selection" ? SELECTION_COLOR : plane.kind === "hover" ? HOVER_COLOR : OUTLINE_COLOR;
    const kind = plane.kind === "base" ? 0 : plane.kind === "texture" ? 1 : plane.kind === "text" ? 2 : plane.kind === "outline" ? 3 : plane.kind === "selection" ? 4 : 5;
    gl.uniform4f(renderer.uniforms.u_rect, plane.rect.left, plane.rect.top, plane.rect.width, plane.rect.height);
    gl.uniform4f(renderer.uniforms.u_source_rect, plane.source.left / sourceSize.width, plane.source.top / sourceSize.height, plane.source.width / sourceSize.width, plane.source.height / sourceSize.height);
    gl.uniform1f(renderer.uniforms.u_depth, plane.z);
    gl.uniform4f(renderer.uniforms.u_color, color[0], color[1], color[2], 1);
    gl.uniform2f(renderer.uniforms.u_rect_size, plane.rect.width, plane.rect.height);
    gl.uniform1f(renderer.uniforms.u_kind, kind);
    gl.uniform1f(renderer.uniforms.u_opacity, plane.opacity);
    const isLine = plane.kind === "outline";
    gl.bindBuffer(gl.ARRAY_BUFFER, isLine ? renderer.lineBuffer : renderer.quadBuffer);
    gl.enableVertexAttribArray(renderer.unitLocation);
    gl.vertexAttribPointer(renderer.unitLocation, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(isLine ? gl.LINE_LOOP : gl.TRIANGLES, 0, isLine ? 4 : 6);
  }
  renderer.renderVersion += 1;
  canvas.dataset.layerRenderVersion = String(renderer.renderVersion);
  canvas.dataset.layerCanvasPixels = `${canvas.width}x${canvas.height}`;
}

export const Layer3DPreview = forwardRef<LayerSceneHandle, Props>(function Layer3DPreview({ src, root, selectedNode, expandedNodeIds, size, renderScale, origin, camera, onSelect }, ref) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const cameraRef = useRef(camera);
  const planesRef = useRef<ScenePlane[]>([]);
  const projectedRef = useRef<ProjectedPlane[]>([]);
  const drawRef = useRef<() => void>(() => {});
  const [rendererStatus, setRendererStatus] = useState<RendererStatus>("loading");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const layout = useMemo(() => buildLayerOverview(root, selectedNode, size, { maxLayers: 512, layerGap: camera.layerGap, expandedIds: expandedNodeIds }), [camera.layerGap, expandedNodeIds, root, selectedNode, size]);
  const records = layout.records;
  const roles = useMemo(() => layerPlaneRoles(records, size), [records, size]);
  const selectedRecord = records.find((record) => record.isSelected) ?? (layout.parent?.isSelected ? layout.parent : null);
  const hoveredRecord = records.find((record) => record.id === hoveredId) ?? null;
  const textureCount = records.filter((record) => roles.get(record.id) === "surface").length;
  const textOnlyCount = records.filter((record) => roles.get(record.id) === "surface" && usesTextOnlyTexture(record)).length;
  const outlineCount = records.filter((record) => roles.get(record.id) === "outline").length;
  const baseLayerZ = Math.min(layout.parent?.z ?? 0, ...records.map((record) => record.z)) - camera.layerGap;
  const pivot = useMemo(() => {
    const depths = [layout.parent?.z, ...records.map((record) => record.z)].filter((depth): depth is number => Number.isFinite(depth));
    const minimumDepth = Math.min(...depths);
    const maximumDepth = Math.max(...depths);
    return {
      x: origin.left + size.width * renderScale / 2,
      y: origin.top + size.height * renderScale / 2,
      z: depths.length > 0 ? (minimumDepth + maximumDepth) / 2 : 0,
    };
  }, [layout.parent?.z, origin.left, origin.top, records, renderScale, size.height, size.width]);

  useEffect(() => {
    if (hoveredId && !hoveredRecord) setHoveredId(null);
  }, [hoveredId, hoveredRecord]);

  const scenePlanes = useMemo(() => {
    // ponytail: retain one dim composite plane only for spatial reference; visual controls render above it without inheriting their parent background.
    const planes: ScenePlane[] = [{ id: "base", node: null, rect: { left: origin.left, top: origin.top, width: size.width * renderScale, height: size.height * renderScale }, source: { left: 0, top: 0, width: size.width, height: size.height }, z: baseLayerZ, kind: "base", opacity: 0.18, hitTestable: false }];
    if (layout.parent) {
      planes.push({ id: `${layout.parent.id}:parent`, node: null, rect: scaledRect(layout.parent, renderScale, origin), source: sourceRect(layout.parent), z: layout.parent.z, kind: "outline", opacity: 0.94, hitTestable: false });
    }
    for (const record of records) {
      const role = roles.get(record.id) ?? "outline";
      const structuralScreen = isStructuralScreenContainer(record, size);
      const kind = role === "surface" ? (usesForegroundMask(record) ? "text" : "texture") : "outline";
      planes.push({ id: record.id, node: record.node, rect: scaledRect(record, renderScale, origin), source: sourceRect(record), z: record.z, kind, opacity: structuralScreen ? 0.72 : role === "outline" ? 0.82 : 0.96, hitTestable: record.hitTestable });
    }
    if (selectedRecord) planes.push({ id: `${selectedRecord.id}:selection`, node: null, rect: scaledRect(selectedRecord, renderScale, origin), source: sourceRect(selectedRecord), z: selectedRecord.z, kind: "selection", opacity: 1, hitTestable: false });
    if (hoveredRecord) planes.push({ id: `${hoveredRecord.id}:hover`, node: null, rect: scaledRect(hoveredRecord, renderScale, origin), source: sourceRect(hoveredRecord), z: hoveredRecord.z, kind: "hover", opacity: 1, hitTestable: false });
    return planes;
  }, [baseLayerZ, hoveredRecord, layout.parent, origin, records, renderScale, roles, selectedRecord, size]);

  drawRef.current = () => {
    const renderer = rendererRef.current;
    if (renderer) drawScene(renderer, planesRef.current, cameraRef.current, size, pivot, projectedRef);
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
    const observer = new ResizeObserver(() => drawRef.current());
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
  }, [src]);

  useImperativeHandle(ref, () => ({
    paintCamera(next) {
      cameraRef.current = next;
      sceneRef.current?.style.setProperty("transform", `translate3d(${next.panX}px, ${next.panY}px, 0)`);
      drawRef.current();
    },
    pick(clientX, clientY) {
      const canvas = canvasRef.current;
      if (!canvas || rendererStatus !== "webgl") return null;
      const rect = canvas.getBoundingClientRect();
      const point = { x: clientX - rect.left, y: clientY - rect.top };
      return projectedRef.current.find((plane) => pointInQuad(point, plane.corners))?.node ?? null;
    },
    hover(clientX, clientY) {
      const canvas = canvasRef.current;
      if (!canvas || rendererStatus !== "webgl") return;
      const rect = canvas.getBoundingClientRect();
      const point = { x: clientX - rect.left, y: clientY - rect.top };
      const nextId = projectedRef.current.find((plane) => pointInQuad(point, plane.corners))?.node.id ?? null;
      setHoveredId((current) => current === nextId ? current : nextId);
    },
    clearHover() {
      setHoveredId((current) => current ? null : current);
    },
  }), [rendererStatus]);

  return (
    <div ref={sceneRef} className={`layer-scene layer-renderer-${rendererStatus}`} style={{ transform: `translate3d(${camera.panX}px, ${camera.panY}px, 0)` }} data-view-mode="layers3d" data-layer-mode="overview" data-layer-parent-id={layout.parentId ?? ""} data-layer-hovered-id={hoveredId ?? ""} data-layer-count={records.length} data-layer-texture-count={textureCount} data-layer-text-only-count={textOnlyCount} data-layer-outline-count={outlineCount} data-layer-selection-count={Number(Boolean(selectedRecord))} data-layer-candidate-count={layout.candidateCount} data-layer-truncated={layout.truncated ? "true" : "false"} data-layer-omitted-count={layout.omittedCount} data-layer-pivot-x={pivot.x.toFixed(2)} data-layer-pivot-y={pivot.y.toFixed(2)} data-layer-pivot-z={pivot.z.toFixed(2)} aria-label="WebGL 3D hierarchy layers">
      <canvas ref={canvasRef} className="layer-webgl-canvas" data-layer-webgl="true" data-layer-renderer={rendererStatus} aria-hidden="true" />
      {rendererStatus === "fallback" && <span className="layer-webgl-fallback">WebGL 不可用，已回退到截图预览。</span>}
      <div className="layer-scene-metadata" hidden aria-hidden="true">
        <span className="layer-scene-base-plane" data-layer-base="true" data-layer-hit-testable="false" />
        {records.map((record) => {
          const role = roles.get(record.id) ?? "outline";
          const textOnly = role === "surface" && usesTextOnlyTexture(record);
          return <button className={`layer-plane ${role} ${record.isSelected ? "selected" : ""}`} data-layer-node-id={record.id} data-layer-depth={record.depth} data-layer-z={record.z} data-layer-z-order={record.zOrder} data-layer-z-order-source={record.zOrderSource} data-layer-selected={record.isSelected ? "true" : "false"} data-layer-role={role} data-layer-texture={role === "surface" ? "true" : "false"} data-layer-content={textOnly ? "text" : role === "surface" ? "control" : "structure"} data-layer-focus={record.isSelected ? "true" : "false"} data-layer-hit-testable={record.hitTestable ? "true" : "false"} key={record.id} type="button" tabIndex={-1} onClick={() => onSelect(record.node)} />;
        })}
      </div>
    </div>
  );
});

Layer3DPreview.displayName = "Layer3DPreview";
