import type { PixelSize, UiNode } from "../../../shared/types";
import type { MeasurementCardData, MeasurementCardEndpoint } from "../../../shared/measurement-card";
import type { QuickSelectCandidate, QuickSelectResult } from "./quick-select";


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
  interruptMotion: () => void;
  fit: () => void;
  pick: (clientX: number, clientY: number) => UiNode | null;
  hover: (clientX: number, clientY: number) => void;
  clearHover: () => void;
  quickSelectAt: (clientX: number, clientY: number) => QuickSelectResult;
  quickSelectPage: (result: QuickSelectResult, page: number) => QuickSelectResult;
  previewQuickSelect: (result: QuickSelectResult | null, candidate: QuickSelectCandidate | null) => void;
  toggleMeasurementPin: () => boolean;
  clearPinnedMeasurement: () => boolean;
  beginMeasurement: (endpoint?: "anchor" | "target") => boolean;
  useSelectedMeasurementNode: () => boolean;
  startMeasurementMode: () => boolean;
  setTemporaryMeasurement: (active: boolean) => boolean;
};

export type MeasurementPicking = {
  endpoint: "anchor" | "target";
  anchor: MeasurementCardEndpoint | null;
  target: MeasurementCardEndpoint | null;
  canUseSelected: boolean;
  selectedLabel: string | null;
  error: string | null;
};
export type LayerMeasurementState = {
  ready: boolean; canPin: boolean; pinned: boolean; summary: string | null;
  card: MeasurementCardData | null; picking: MeasurementPicking | null;
  mode: "off" | "live" | "temporary" | "fixed" | "picking";
  anchor: MeasurementCardEndpoint | null; target: MeasurementCardEndpoint | null; hovering: boolean;
};

export type LayerPlaneRole = "surface" | "outline";
export type RenderKind = "native" | "composite" | "isolated" | "outline" | "invisible" | "selection" | "hover";
export type Rect = { left: number; top: number; width: number; height: number };
export type ScenePlane = { id: string; node: UiNode | null; rect: Rect; source: Rect; textureSrc: string | null; textureSize: PixelSize; z: number; kind: RenderKind; opacity: number; hitTestable: boolean; outlineRequired?: boolean; deviceInvisible?: boolean;
  quickSelect?: { collapsed: boolean; screen: Rect } };
export type Point = { x: number; y: number };
export type ScenePivot = Point & { z: number };
export type LayerPresentation = { depths: Map<string, number>; center: ScenePivot; pivot: ScenePivot; scale: number };
export type ProjectedPlane = { node: UiNode; corners: Point[]; depth: number;
  painted?: { plane: ScenePlane; cornerDepths: number[]; camera: LayerCamera; pivot: ScenePivot; visible: boolean; kind: RenderKind } };
export type RendererStatus = "loading" | "webgl" | "fallback";
export type Renderer = {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  quadBuffer: WebGLBuffer;
  lineBuffer: WebGLBuffer;
  texture: WebGLTexture;
  layerTextures: Map<string, WebGLTexture>;
  layerTextureBytes: Map<string, number>;
  layerContentRects: Map<string, Rect | null>;
  layerAlphaScans: Map<string, Promise<Rect | null>>;
  unitLocation: number;
  lineLocation: number;
  lineVertices: Float32Array;
  sourcePlanes: readonly ScenePlane[] | null;
  preparedPlanes: ScenePlane[];
  uniforms: Record<string, WebGLUniformLocation>;
  textureReady: boolean;
  cssWidth: number;
  cssHeight: number;
  renderVersion: number;
};

export type TextureContentResult = { rect: Rect | null | undefined; scan: (() => Promise<Rect | null>) | null };
export type LayerTextureUpload = false | { uploaded: true; scan: (() => Promise<Rect | null>) | null };
