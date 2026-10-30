import type { Rectangle } from "electron";
import type { WindowMode } from "../../shared/types";

export const START_WINDOW_SIZE = { width: 440, height: 640 };
export const START_WINDOW_MIN = { width: 360, height: 520 };
const WORKSPACE_SIZE = { width: 1280, height: 880 };
const WORKSPACE_MIN = { width: 960, height: 700 };

type WindowPort = {
  getBounds(): Rectangle;
  getNormalBounds(): Rectangle;
  isDestroyed(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  setMinimumSize(width: number, height: number): void;
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

/** Each page keeps its own bounds for the lifetime of this desktop window. */
export function createWindowLayout(window: WindowPort, workArea: (bounds: Rectangle) => Rectangle, fixedViewport = false) {
  let mode: WindowMode = "home", applied: WindowMode = "home";
  let homeBounds = window.getBounds(), workspaceBounds: Rectangle | null = null;
  let workspaceMaximized = false, leavingMaximized = false, deferredFullScreen = false;

  function apply() {
    if (window.isDestroyed() || fixedViewport || leavingMaximized) return;
    // Keep an explicit full-screen choice; apply the current page size when it ends.
    if (window.isFullScreen()) { deferredFullScreen = true; return; }
    if (mode === "home" && window.isMaximized()) {
      leavingMaximized = true;
      window.unmaximize();
      return;
    }
    const current = window.getBounds();
    const requested = mode === "home" ? homeBounds : workspaceBounds ?? {
      ...WORKSPACE_SIZE,
      x: current.x + (current.width - WORKSPACE_SIZE.width) / 2,
      y: current.y + (current.height - WORKSPACE_SIZE.height) / 2,
    };
    const area = workArea(requested);
    const minimum = mode === "home" ? START_WINDOW_MIN : WORKSPACE_MIN;
    window.setMinimumSize(Math.min(minimum.width, area.width), Math.min(minimum.height, area.height));
    window.setBounds(fit(requested, area));
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
