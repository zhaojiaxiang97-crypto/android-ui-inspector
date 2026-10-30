import { createAlphaMask, scanAlphaSlice } from "./texture-alpha";
import { alphaScanSliceRows, textureAlphaScanMode, textureDimensions } from "../../../shared/layer-textures";
import { type Renderer, type TextureContentResult, type TextureContent, type LayerTextureUpload, type ScenePlane, type LayerCamera, type ScenePivot, type ProjectedPlane, type RenderKind, type Point } from "./types";
import { cameraRotation, projectPlane } from "./projection";
import { outlineIsVisible, prepareScenePlanes } from "./scene-planes";
import { DEFAULT_LAYER_APPEARANCE, LAYER_OUTLINE_COLORS, type LayerAppearance, type LayerDisplayMode } from "./appearance";


const MAX_CANVAS_PIXELS = 4_000_000;
const SELECTION_COLOR: readonly [number, number, number] = [0.35, 0.65, 1.0];
const HOVER_COLOR: readonly [number, number, number] = [0.20, 0.56, 0.96];
const INVISIBLE_COLOR: readonly [number, number, number] = [0.65, 0.73, 0.84];

const VERTEX_SHADER = `
  attribute vec2 a_unit;
  attribute vec4 a_line;
  attribute vec3 a_line_end;
  uniform vec4 u_rect;
  uniform mediump vec4 u_source_rect;
  uniform vec2 u_viewport;
  uniform vec3 u_pivot;
  uniform float u_depth;
  uniform float u_distance;
  uniform vec4 u_rotation;
  uniform vec2 u_roll;
  uniform mediump float u_kind;
  uniform float u_line_width;
  varying vec2 v_uv;
  varying vec2 v_source;
  varying float v_line_alpha;
  vec4 project(vec3 position) {
    float px = position.x - u_pivot.x;
    float py = u_pivot.y - position.y;
    float pz = position.z - u_pivot.z;
    float y_pitch = u_rotation.z * py - u_rotation.w * pz;
    float z_pitch = u_rotation.w * py + u_rotation.z * pz;
    float x_yaw = u_rotation.x * px + u_rotation.y * z_pitch;
    float z_yaw = -u_rotation.y * px + u_rotation.x * z_pitch;
    float x_roll = u_roll.x * x_yaw - u_roll.y * y_pitch;
    float y_roll = u_roll.y * x_yaw + u_roll.x * y_pitch;
    float clip_w = max(1.0, u_distance - z_yaw);
    float clip_x = (u_pivot.x / (u_viewport.x * 0.5) - 1.0) * clip_w + x_roll * u_distance / (u_viewport.x * 0.5);
    float clip_y = (1.0 - u_pivot.y / (u_viewport.y * 0.5)) * clip_w + y_roll * u_distance / (u_viewport.y * 0.5);
    // Keep clip-space W so WebGL perspective-correctly interpolates the
    // screenshot texture across a tilted plane instead of shearing it.
    return vec4(clip_x, clip_y, 0.0, clip_w);
  }
  void main() {
    bool line = u_kind > 2.5 && u_kind < 3.5;
    gl_Position = project(line ? a_line.xyz : vec3(u_rect.xy + a_unit * u_rect.zw, u_depth));
    if (line) {
      vec4 other = project(vec3(a_line_end.xy, a_line.z));
      vec2 direction = (other.xy / other.w - gl_Position.xy / gl_Position.w) * u_viewport;
      vec2 normal = vec2(-direction.y, direction.x) / max(length(direction), 0.0001);
      // CSS-pixel width stays readable at any zoom, camera angle or display DPI.
      gl_Position.xy += normal * a_line_end.z * u_line_width / u_viewport * gl_Position.w;
    }
    v_uv = a_unit;
    v_source = u_source_rect.xy + a_unit * u_source_rect.zw;
    v_line_alpha = a_line.w;
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
  uniform float u_highlight_fill;
  varying vec2 v_uv;
  varying vec2 v_source;
  varying float v_line_alpha;
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
      if (u_kind > 5.5) {
        float along = edge_pixels.y < edge_pixels.x ? v_uv.x * u_rect_size.x : v_uv.y * u_rect_size.y;
        float dash = 1.0 - step(4.0, mod(along, 8.0));
        gl_FragColor = vec4(u_color.rgb, edge * dash * u_opacity);
        return;
      }
      gl_FragColor = vec4(u_color.rgb, max(edge, u_highlight_fill) * u_opacity);
      return;
    }
    gl_FragColor = vec4(u_color.rgb, v_line_alpha * u_opacity);
  }
`;

function compileShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer | null {
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
  const lineLocation = gl.getAttribLocation(program, "a_line");
  const lineEndLocation = gl.getAttribLocation(program, "a_line_end");
  const uniformNames = ["u_rect", "u_source_rect", "u_viewport", "u_pivot", "u_depth", "u_distance", "u_rotation", "u_roll", "u_texture", "u_color", "u_rect_size", "u_kind", "u_opacity", "u_highlight_fill", "u_line_width"];
  const uniforms = Object.fromEntries(uniformNames.map((name) => [name, gl.getUniformLocation(program, name)])) as Record<string, WebGLUniformLocation | null>;
  if (!quadBuffer || !lineBuffer || !texture || unitLocation < 0 || lineLocation < 0 || lineEndLocation < 0 || Object.values(uniforms).some((location) => !location)) {
    gl.deleteBuffer(quadBuffer);
    gl.deleteBuffer(lineBuffer);
    gl.deleteTexture(texture);
    gl.deleteProgram(program);
    canvas.dataset.layerWebglError = "bindings";
    return null;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { canvas, gl, program, quadBuffer, lineBuffer, texture, layerTextures: new Map(), layerTextureBytes: new Map(), layerContentRects: new Map(), layerAlphaMasks: new Map(), layerAlphaScans: new Map(), unitLocation, lineLocation, lineEndLocation, lineVertices: new Float32Array(0), sourcePlanes: null, preparedPlanes: [], uniforms: uniforms as Record<string, WebGLUniformLocation>, textureReady: false, cssWidth: 0, cssHeight: 0, renderVersion: 0 };
}

export function disposeRenderer(renderer: Renderer) {
  const { gl } = renderer;
  gl.deleteBuffer(renderer.quadBuffer);
  gl.deleteBuffer(renderer.lineBuffer);
  gl.deleteTexture(renderer.texture);
  for (const texture of renderer.layerTextures.values()) gl.deleteTexture(texture);
  gl.deleteProgram(renderer.program);
  renderer.layerAlphaMasks.clear(); renderer.layerContentRects.clear(); renderer.layerAlphaScans.clear();
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

export function uploadTexture(renderer: Renderer, image: HTMLImageElement) {
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

// Inspect the decoded independent image once, including historical snapshots.
// Normalized coordinates also work for downsampled textures and folded branches.
function textureContentRect(image: ImageBitmap | HTMLCanvasElement, texturePixelBudget: number): TextureContentResult {
  const mode = textureAlphaScanMode(image.width, image.height);
  if (mode === "none" || image.width * image.height > texturePixelBudget) return { rect: { left: 0, top: 0, width: 1, height: 1 }, scan: null };
  if (mode === "sliced") return { rect: null, scan: () => scanTextureContentRectInSlices(image) };
  const canvas = image instanceof HTMLCanvasElement ? image : document.createElement("canvas");
  try {
    if (canvas !== image) {
      const size = textureDimensions(image.width, image.height, MAX_CANVAS_PIXELS);
      canvas.width = size.width; canvas.height = size.height;
    }
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return { rect: undefined, scan: null };
    if (canvas !== image) context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const { width, height } = canvas;
    const pixels = context.getImageData(0, 0, width, height).data;
    const mask = createAlphaMask(width, height);
    return { rect: scanAlphaSlice(pixels, mask, 0, height), mask, scan: null };
  } catch { return { rect: undefined, scan: null }; } // A failed read must not invent a smaller layout.
  finally { if (canvas !== image) canvas.width = canvas.height = 0; }
}

async function scanTextureContentRectInSlices(image: ImageBitmap | HTMLCanvasElement): Promise<TextureContent> {
  const width = image.width, height = image.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return { rect: undefined };
    context.drawImage(image, 0, 0);
    const mask = createAlphaMask(width, height);
    let left = width, top = height, right = 0, bottom = 0;
    const rows = alphaScanSliceRows(height);
    for (let startY = 0; startY < height; startY += rows) {
      const sliceHeight = Math.min(rows, height - startY);
      const pixels = context.getImageData(0, startY, width, sliceHeight).data;
      const bounds = scanAlphaSlice(pixels, mask, startY, sliceHeight);
      if (bounds) {
        const sliceLeft = Math.round(bounds.left * width), sliceRight = Math.round((bounds.left + bounds.width) * width);
        left = Math.min(left, sliceLeft);
        top = Math.min(top, Math.round(bounds.top * height));
        right = Math.max(right, sliceRight);
        bottom = Math.max(bottom, Math.round((bounds.top + bounds.height) * height));
      }
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    return { mask, rect: right > left && bottom > top ? { left: left / width, top: top / height, width: (right - left) / width, height: (bottom - top) / height } : null };
  } catch { return { rect: undefined }; } finally {
    canvas.width = canvas.height = 0;
  }
}

export function uploadLayerTexture(renderer: Renderer, src: string, image: ImageBitmap | HTMLCanvasElement, maxPixels: number): LayerTextureUpload {
  const { gl } = renderer;
  const size = textureDimensions(image.width, image.height, maxPixels, gl.getParameter(gl.MAX_TEXTURE_SIZE));
  let resized: HTMLCanvasElement | null = null;
  if (size.width !== image.width || size.height !== image.height) {
    resized = document.createElement("canvas");
    resized.width = size.width; resized.height = size.height;
    const context = resized.getContext("2d");
    if (!context) { resized.width = resized.height = 0; return false; }
    context.drawImage(image, 0, 0, size.width, size.height);
  }
  const texture = gl.createTexture();
  if (!texture) { if (resized) resized.width = resized.height = 0; return false; }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, resized ?? image);
  if (gl.getError() !== gl.NO_ERROR) {
    gl.deleteTexture(texture);
    if (resized) resized.width = resized.height = 0;
    return false;
  }
  gl.deleteTexture(renderer.layerTextures.get(src) ?? null);
  renderer.layerTextures.set(src, texture);
  renderer.layerTextureBytes.set(src, size.width * size.height * 4);
  const content = textureContentRect(resized ?? image, maxPixels);
  renderer.layerContentRects.delete(src); renderer.layerAlphaMasks.delete(src);
  if (content.rect !== undefined) renderer.layerContentRects.set(src, content.rect);
  if (content.mask) renderer.layerAlphaMasks.set(src, content.mask);
  renderer.sourcePlanes = null;
  if (!content.scan) { if (resized) resized.width = resized.height = 0; return { uploaded: true, scan: null }; }
  const scan = content.scan;
  return { uploaded: true, scan: async () => {
    try { return await scan(); } finally { if (resized) resized.width = resized.height = 0; }
  } };
}

export async function loadLayerImage(src: string) {
  const image = new Image();
  image.src = src;
  try { await image.decode(); return await createImageBitmap(image, { premultiplyAlpha: "none" }); }
  finally { image.src = ""; }
}

export function drawScene(renderer: Renderer, planes: readonly ScenePlane[], camera: LayerCamera, pivot: ScenePivot, projectedRef: { current: ProjectedPlane[] }, appearance: LayerAppearance = DEFAULT_LAYER_APPEARANCE, displayMode: LayerDisplayMode = "images") {
  renderer.canvas.dataset.layerInvisibleCount = String(planes.filter(plane => plane.kind === "invisible").length);
  const displayChanged = renderer.canvas.dataset.layerDisplayMode !== displayMode;
  renderer.canvas.dataset.layerDisplayMode = displayMode;
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
  gl.bindTexture(gl.TEXTURE_2D, renderer.texture);
  gl.uniform1i(renderer.uniforms.u_texture, 0);
  gl.uniform2f(renderer.uniforms.u_viewport, renderer.cssWidth, renderer.cssHeight);
  gl.uniform3f(renderer.uniforms.u_pivot, pivot.x, pivot.y, pivot.z);
  gl.uniform1f(renderer.uniforms.u_distance, Math.max(1, camera.distance));
  const rotation = cameraRotation(camera);
  gl.uniform4f(renderer.uniforms.u_rotation, rotation.cy, rotation.sy, rotation.cp, rotation.sp);
  gl.uniform2f(renderer.uniforms.u_roll, rotation.cr, rotation.sr);
  const paintRank = (kind: RenderKind) => kind === "hover" ? 3 : kind === "selection" ? 2 : kind === "outline" ? 1 : 0;
  const preparedChanged = renderer.sourcePlanes !== planes;
  if (preparedChanged) {
    renderer.preparedPlanes = prepareScenePlanes(planes, renderer.layerContentRects, renderer.layerTextures, "images", renderer.layerAlphaMasks);
    renderer.sourcePlanes = planes;
    canvas.dataset.layerTrimmedCount = String(renderer.preparedPlanes.filter(plane => plane.hitPolicy === "content"
      && planes.find(original => original.id === plane.id)?.rect !== plane.rect).length);
  }
  const outlineColor = canvas.ownerDocument.documentElement.dataset.appearance === "light" ? LAYER_OUTLINE_COLORS.light : LAYER_OUTLINE_COLORS.dark;
  // Transform the eye back to layer coordinates. Rectangle-center depth can
  // reverse an off-center control and its background during an orbit.
  // ponytail: perpendicular eye distance gives exact painter order for parallel
  // planes; independent per-layer rotations would need depth-aware rendering.
  const eyeZ = pivot.z + camera.distance * rotation.cy * rotation.cp;
  // Wireframes retain captured geometry, not the alpha-trimmed image footprint.
  // Keep prepared image planes and texture caches untouched for the return trip.
  const displayPlanes = displayMode === "wireframe"
    ? prepareScenePlanes(planes, renderer.layerContentRects, renderer.layerTextures, "wireframe", renderer.layerAlphaMasks) : renderer.preparedPlanes;
  const ordered = displayPlanes.map((plane) => ({ plane, distance: Math.abs(plane.z - eyeZ), projected: projectPlane(plane, pivot, camera, rotation) })).sort((left, right) => {
    return right.distance - left.distance || paintRank(left.plane.kind) - paintRank(right.plane.kind);
  });
  projectedRef.current = ordered.slice().reverse()
    .filter(({ plane }) => plane.hitTestable && plane.node)
    .map(({ plane, projected }) => ({ node: plane.node!, corners: projected.corners, depth: projected.depth, painted: {
      plane, cornerDepths: projected.corners.map(corner => corner.depth), camera: { ...camera }, pivot: { ...pivot }, kind: plane.kind,
      visible: plane.opacity > 0 && (plane.kind !== "outline" || plane.highlighted || outlineIsVisible(plane, appearance.showOutlines)),
      edgeOnly: displayMode === "wireframe" || plane.hitPolicy === "edge",
      alphaMask: plane.textureSrc ? renderer.layerAlphaMasks.get(plane.textureSrc) : undefined,
    } }));
  let probe: Point | null = null;
  probeSearch: for (const edgeOnly of [false, true]) for (const plane of projectedRef.current) {
    if (!plane.painted?.visible || Boolean(plane.painted.edgeOnly) !== edgeOnly) continue;
    const points = plane.painted.edgeOnly ? plane.corners.slice(0, 2) : plane.corners;
    const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    if (x >= 0 && x <= renderer.cssWidth && y >= 0 && y <= renderer.cssHeight) {
      probe = { x, y };
      break probeSearch;
    }
  }
  if (probe) {
    canvas.dataset.layerProbeX = String(probe.x);
    canvas.dataset.layerProbeY = String(probe.y);
  } else {
    delete canvas.dataset.layerProbeX;
    delete canvas.dataset.layerProbeY;
  }
  // Batch adjacent outlines only: never move a rear border across a textured
  // plane. Painter order, transparency and front-most picking stay aligned.
  // Four edges, six triangle vertices per edge, seven floats per vertex.
  if (renderer.lineVertices.length < ordered.length * 168) renderer.lineVertices = new Float32Array(ordered.length * 168);
  const lines = renderer.lineVertices;
  let lineLength = 0, lineStart = 0, drawCalls = 0;
  const entries = ordered.map(entry => {
    const { plane } = entry;
    const texture = plane.textureSrc === null || plane.textureSrc === "" ? renderer.texture : renderer.layerTextures.get(plane.textureSrc);
    const missingTexture = (plane.kind === "native" || plane.kind === "composite" || plane.kind === "isolated") && !texture;
    const renderKind = missingTexture ? "outline" : plane.kind;
    const outlineVisible = renderKind === "outline" && !plane.highlighted && outlineIsVisible(plane, appearance.showOutlines);
    if (outlineVisible) {
      const { left, top, width, height } = plane.rect;
      const emphasis = displayMode === "wireframe" || missingTexture || plane.outlinePolicy === "required" ? 0.85 : 0.6;
      const quiet = appearance.structureMode === "regular" && displayMode === "images" && plane.quietStructure && !missingTexture && plane.outlinePolicy !== "required" ? .28 : 1;
      // Keep the same thin contour while orbiting. Fading it by face angle
      // hides the very depth boundaries a side view is meant to reveal.
      const alpha = quiet * plane.opacity * emphasis;
      const corners = [[left, top], [left + width, top], [left + width, top + height], [left, top + height]];
      for (let edge = 0; edge < 4; edge++) {
        const a = corners[edge], b = corners[(edge + 1) % 4];
        for (const [atEnd, side] of [[0, 1], [0, -1], [1, -1], [1, -1], [0, -1], [1, 1]]) {
          const point = atEnd ? b : a, other = atEnd ? a : b;
          lines[lineLength++] = point[0]; lines[lineLength++] = point[1]; lines[lineLength++] = plane.z; lines[lineLength++] = alpha;
          lines[lineLength++] = other[0]; lines[lineLength++] = other[1]; lines[lineLength++] = side;
        }
      }
    }
    const corners = entry.projected.corners;
    const projectedWidth = Math.min(Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y), Math.hypot(corners[2].x - corners[3].x, corners[2].y - corners[3].y));
    const projectedHeight = Math.min(Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y), Math.hypot(corners[2].x - corners[1].x, corners[2].y - corners[1].y));
    return { plane, texture, renderKind, lineCount: outlineVisible ? 24 : 0, projectedWidth, projectedHeight };
  });
  canvas.dataset.layerOrdinaryBorderCount = String(entries.filter(entry => entry.lineCount > 0).length);
  gl.bindBuffer(gl.ARRAY_BUFFER, renderer.lineBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, lines.subarray(0, lineLength), gl.DYNAMIC_DRAW);
  let pendingLines = 0;
  const flushLines = () => {
    if (!pendingLines) return;
    gl.uniform1f(renderer.uniforms.u_kind, 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, renderer.lineBuffer);
    gl.disableVertexAttribArray(renderer.unitLocation);
    gl.enableVertexAttribArray(renderer.lineLocation);
    gl.enableVertexAttribArray(renderer.lineEndLocation);
    gl.vertexAttribPointer(renderer.lineLocation, 4, gl.FLOAT, false, 28, 0);
    gl.vertexAttribPointer(renderer.lineEndLocation, 3, gl.FLOAT, false, 28, 16);
    // A single hairline keeps dense hierarchies quiet, including on white surfaces.
    gl.uniform4f(renderer.uniforms.u_color, outlineColor[0], outlineColor[1], outlineColor[2], 1);
    gl.uniform1f(renderer.uniforms.u_line_width, displayMode === "wireframe" ? 1 : 0.75);
    gl.uniform1f(renderer.uniforms.u_opacity, 1);
    gl.drawArrays(gl.TRIANGLES, lineStart, pendingLines);
    drawCalls++;
    lineStart += pendingLines; pendingLines = 0;
  };
  for (const { plane, texture, renderKind, lineCount, projectedWidth, projectedHeight } of entries) {
    if (renderKind === "outline") { pendingLines += lineCount; continue; }
    flushLines();
    gl.bindTexture(gl.TEXTURE_2D, texture ?? renderer.texture);
    const color = renderKind === "selection" ? SELECTION_COLOR : renderKind === "hover" ? HOVER_COLOR : renderKind === "invisible" ? INVISIBLE_COLOR : outlineColor;
    const kind = plane.deviceInvisible ? 6 : renderKind === "native" || renderKind === "composite" ? 1 : renderKind === "isolated" ? 2 : renderKind === "selection" ? 4 : renderKind === "invisible" ? 6 : 5;
    gl.uniform4f(renderer.uniforms.u_rect, plane.rect.left, plane.rect.top, plane.rect.width, plane.rect.height);
    gl.uniform4f(renderer.uniforms.u_source_rect, plane.source.left / plane.textureSize.width, plane.source.top / plane.textureSize.height, plane.source.width / plane.textureSize.width, plane.source.height / plane.textureSize.height);
    gl.uniform1f(renderer.uniforms.u_depth, plane.z);
    gl.uniform4f(renderer.uniforms.u_color, color[0], color[1], color[2], 1);
    gl.uniform2f(renderer.uniforms.u_rect_size, Math.max(1, projectedWidth), Math.max(1, projectedHeight));
    gl.uniform1f(renderer.uniforms.u_kind, kind);
    gl.uniform1f(renderer.uniforms.u_opacity, plane.opacity);
    const fill = displayMode === "wireframe" ? 0 : appearance.highlightStrength === "strong" ? 0.32 : appearance.highlightStrength === "medium" ? 0.16 : 0;
    gl.uniform1f(renderer.uniforms.u_highlight_fill, plane.deviceInvisible ? 0 : renderKind === "selection" ? fill : renderKind === "hover" ? fill * 0.5 : 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, renderer.quadBuffer);
    gl.disableVertexAttribArray(renderer.lineLocation);
    gl.disableVertexAttribArray(renderer.lineEndLocation);
    gl.enableVertexAttribArray(renderer.unitLocation);
    gl.vertexAttribPointer(renderer.unitLocation, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    drawCalls++;
  }
  flushLines();
  renderer.renderVersion += 1;
  canvas.dataset.layerRenderVersion = String(renderer.renderVersion);
  canvas.dataset.layerCanvasPixels = `${canvas.width}x${canvas.height}`;
  canvas.dataset.layerDrawCalls = String(drawCalls);
  // Report identities after submission, not the number of received images.
  // Fully clipped images still count as processed, but never as visible pixels.
  if (preparedChanged || displayChanged) {
    const drawnIds = new Set(entries.filter(entry => entry.renderKind === "native").map(entry => entry.plane.id));
    canvas.dataset.layerCommittedNativeTextures = JSON.stringify(planes
      .filter(plane => plane.kind === "native" && plane.textureSrc && renderer.layerTextures.has(plane.textureSrc))
      .map(plane => ({ id: plane.id, key: plane.textureSrc, drawn: drawnIds.has(plane.id) })));
  }
}
