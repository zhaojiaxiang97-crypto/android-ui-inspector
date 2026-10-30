import type { Rectangle } from "electron";
import type { WindowMode } from "../../shared/types";

export const START_WINDOW_SIZE = { width: 440, height: 520 };
export const START_WINDOW_MIN = START_WINDOW_SIZE;
const WORKSPACE_SIZE = { width: 1280, height: 880 };
const WORKSPACE_MIN = { width: 960, height: 700 };

type WindowPort = {
  getBounds(): Rectangle;
  getNormalBounds(): Rectangle;
  isDestroyed(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  setMinimumSize(width: number, height: number): void;
  setResizable(value: boolean): void;
  setMaximizable(value: boolean): void;
  setFullScreenable(value: boolean): void;
  setFullScreen(value: boolean): void;
  setBounds(bounds: Rectangle): void;
  maximize(): void;
  unmaximize(): void;
  on(event: "unmaximize" | "leave-full-screen", listener: () => void): unknown;
};

function fit(bounds: Rectangle, area: Rectangle): Rectangle {
  const width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height);
  return {
    width, height,
    x: Math.round(Math.min(Math.max(bounds.x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(bounds.y, area.y), area.y + area.height - height)),
  };
}

/** Home has a fixed size; workspace keeps its user-adjusted bounds. */
export function createWindowLayout(window: WindowPort, workArea: (bounds: Rectangle) => Rectangle, fixedViewport = false) {
  let mode: WindowMode = "home", applied: WindowMode = "home";
  let homeBounds = window.getBounds(), workspaceBounds: Rectangle | null = null;
  let workspaceMaximized = false, leavingMaximized = false, deferredFullScreen = false;

  function setControls() {
    const flexible = mode === "workspace";
    window.setResizable(flexible);
    window.setMaximizable(flexible);
    window.setFullScreenable(flexible);
  }
  if (!fixedViewport && !window.isDestroyed()) setControls();

  function apply() {
    if (window.isDestroyed() || fixedViewport || leavingMaximized) return;
    if (window.isFullScreen()) {
      deferredFullScreen = true;
      if (mode === "home") window.setFullScreen(false);
      return;
    }
    if (mode === "home" && window.isMaximized()) {
      leavingMaximized = true;
      window.unmaximize();
      return;
    }
    const current = window.getBounds();
    const requested = mode === "home" ? { ...homeBounds, ...START_WINDOW_SIZE } : workspaceBounds ?? {
      ...WORKSPACE_SIZE,
      x: current.x + (current.width - WORKSPACE_SIZE.width) / 2,
      y: current.y + (current.height - WORKSPACE_SIZE.height) / 2,
    };
    const area = workArea(requested);
    const minimum = mode === "home" ? START_WINDOW_MIN : WORKSPACE_MIN;
    // Native resizing must be enabled before restoring the workspace bounds.
    if (mode === "workspace") setControls();
    window.setMinimumSize(Math.min(minimum.width, area.width), Math.min(minimum.height, area.height));
    window.setBounds(fit(requested, area));
    if (mode === "home") setControls();
    applied = mode;
    if (mode === "workspace" && workspaceMaximized && !window.isMaximized()) window.maximize();
  }

  window.on("unmaximize", () => {
    if (!leavingMaximized) return;
    leavingMaximized = false;
    apply();
  });
  window.on("leave-full-screen", () => {
    if (!deferredFullScreen) return;
    deferredFullScreen = false;
    apply();
  });

  return {
    setMode(next: WindowMode) {
      if (window.isDestroyed() || fixedViewport || mode === next) return;
      if (applied === mode && !leavingMaximized && !deferredFullScreen) {
        if (mode === "home") homeBounds = window.getNormalBounds();
        else { workspaceBounds = window.getNormalBounds(); workspaceMaximized = window.isMaximized(); }
      }
      mode = next;
      apply();
    },
  };
}
