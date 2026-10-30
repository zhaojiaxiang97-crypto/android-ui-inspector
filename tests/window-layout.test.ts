import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createWindowLayout } from "../electron/desktop/window-layout";

const initial = { x: 500, y: 150, width: 440, height: 640 };
function fixture(fixedViewport = false) {
  const events = new EventEmitter();
  let bounds = { ...initial }, normal = { ...initial }, area = { x: 0, y: 25, width: 1440, height: 875 };
  let maximized = false, fullScreen = false, destroyed = false, changes = 0;
  let minimum = [360, 520];
  const window = {
    getBounds: () => ({ ...bounds }), getNormalBounds: () => ({ ...normal }),
    isDestroyed: () => destroyed, isMaximized: () => maximized, isFullScreen: () => fullScreen,
    setMinimumSize: (width: number, height: number) => { minimum = [width, height]; },
    setBounds: (value: typeof bounds) => { bounds = normal = { ...value }; changes++; },
    maximize: () => { maximized = true; bounds = { ...area }; },
    unmaximize: () => {}, // Electron emits unmaximize asynchronously.
    on: events.on.bind(events),
  };
  return {
    layout: createWindowLayout(window, () => area, fixedViewport), window,
    bounds: () => bounds, minimum: () => minimum, changes: () => changes,
    area: (value: typeof area) => { area = value; },
    unmaximized: () => { maximized = false; bounds = { ...normal }; events.emit("unmaximize"); },
    fullScreen: (value: boolean) => { fullScreen = value; if (!value) events.emit("leave-full-screen"); },
    destroy: () => { destroyed = true; },
  };
}

test("home and workspace remember separate user-adjusted bounds", () => {
  const f = fixture();
  f.layout.setMode("home"); assert.equal(f.changes(), 0);
  const home = { x: 600, y: 100, width: 480, height: 660 };
  f.window.setBounds(home); f.layout.setMode("workspace");
  assert.deepEqual(f.minimum(), [960, 700]);
  assert.equal(f.bounds().width, 1280); assert.equal(f.bounds().height, 875);
  const workspace = { x: 120, y: 50, width: 1100, height: 800 };
  f.window.setBounds(workspace); f.layout.setMode("home");
  assert.deepEqual(f.bounds(), home); assert.deepEqual(f.minimum(), [360, 520]);
  f.layout.setMode("workspace"); assert.deepEqual(f.bounds(), workspace);
  const changes = f.changes(); f.layout.setMode("workspace"); assert.equal(f.changes(), changes);
});

test("a removed monitor and small work area cannot strand the window", () => {
  const f = fixture(); f.layout.setMode("workspace");
  f.window.setBounds({ x: 1700, y: 100, width: 1100, height: 800 });
  f.layout.setMode("home"); f.area({ x: -800, y: 30, width: 800, height: 600 });
  f.layout.setMode("workspace");
  assert.deepEqual(f.bounds(), { x: -800, y: 30, width: 800, height: 600 });
  assert.deepEqual(f.minimum(), [800, 600]);
});

test("returning home from a maximized workspace restores the compact window", () => {
  const f = fixture(); f.layout.setMode("workspace"); f.window.maximize();
  f.layout.setMode("home"); f.unmaximized(); assert.deepEqual(f.bounds(), initial);
  f.layout.setMode("workspace"); assert.equal(f.window.isMaximized(), true);
});

test("rapid navigation during unmaximize keeps the last requested page", () => {
  const f = fixture(); f.layout.setMode("workspace"); f.window.maximize();
  f.layout.setMode("home"); f.layout.setMode("workspace"); f.unmaximized();
  assert.equal(f.window.isMaximized(), true);
  f.layout.setMode("home"); f.unmaximized(); assert.deepEqual(f.bounds(), initial);
});

test("full screen stays under user control and applies the final page on exit", () => {
  const f = fixture(); f.layout.setMode("workspace");
  const workspace = { x: 100, y: 60, width: 1150, height: 750 };
  f.window.setBounds(workspace); f.fullScreen(true);
  f.layout.setMode("home"); assert.deepEqual(f.bounds(), workspace);
  f.fullScreen(false); assert.deepEqual(f.bounds(), initial);
  f.layout.setMode("workspace"); assert.deepEqual(f.bounds(), workspace);
  f.fullScreen(true); f.layout.setMode("home"); f.layout.setMode("workspace");
  f.fullScreen(false); assert.deepEqual(f.bounds(), workspace);
});

test("fixed visual fixtures and closed windows never resize", () => {
  const fixed = fixture(true); fixed.layout.setMode("workspace"); assert.equal(fixed.changes(), 0);
  const closed = fixture(); closed.destroy(); closed.layout.setMode("workspace"); assert.equal(closed.changes(), 0);
});
