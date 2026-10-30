import { clipLayerImageToOutlines, composeSubtreeImage } from "../../../shared/layer-textures";
import { createRenderer, disposeRenderer, drawScene, loadLayerImage, uploadLayerTexture, uploadTexture } from "./webgl-renderer";

export type SceneScheduler = {
  now(): number;
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
  setTimer(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimer(id: ReturnType<typeof setTimeout>): void;
  reducedMotion(): boolean;
};
export type SceneRuntimePorts = {
  scheduler: SceneScheduler;
  createRenderer: typeof createRenderer;
  disposeRenderer: typeof disposeRenderer;
  draw: typeof drawScene;
  uploadScreenshot: typeof uploadTexture;
  loadScreenshot(src: string, ready: (image: HTMLImageElement) => void, failed: () => void): () => void;
  decode: typeof loadLayerImage;
  compose: typeof composeSubtreeImage;
  clip: typeof clipLayerImageToOutlines;
  uploadLayer: typeof uploadLayerTexture;
};
export const browserScenePorts: SceneRuntimePorts = {
  scheduler: {
    now: () => performance.now(), requestFrame: callback => requestAnimationFrame(callback), cancelFrame: id => cancelAnimationFrame(id),
    setTimer: (callback, delay) => setTimeout(callback, delay), clearTimer: id => clearTimeout(id),
    reducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  },
  createRenderer, disposeRenderer, draw: drawScene, uploadScreenshot: uploadTexture,
  loadScreenshot(src, ready, failed) {
    const image = new Image(); image.onload = () => ready(image); image.onerror = failed; image.src = src;
    return () => { image.onload = null; image.onerror = null; };
  },
  decode: loadLayerImage, compose: composeSubtreeImage, clip: clipLayerImageToOutlines, uploadLayer: uploadLayerTexture,
};
