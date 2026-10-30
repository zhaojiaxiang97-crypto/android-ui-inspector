import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { makeNode } from "../benchmarks/fixtures";
import { DebugSession } from "../electron/automation/debug-session";
import { readMcpSnapshot } from "../electron/automation/mcp-snapshot";
import type { UiNode, UiSnapshot } from "../shared/types";

const pkg = "com.example.overlap";
const frame = { width: 360, height: 640, rotation: 0 as const };
const target = { packageName: pkg, activityName: ".Main", component: `${pkg}/.Main`, windowId: "main" };
const confirmation = { description: "已查看此快照整屏截图，收藏标签清晰可见；侧栏草稿箱没有出现在点击位置。" };
const bounds = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom, raw: "" });

async function screenshot(change?: { left: number; top: number; width?: number; height?: number }, dimensions = frame) {
  let image = sharp({ create: { width: dimensions.width, height: dimensions.height, channels: 4, background: "#202020" } });
  if (change) image = image.composite([{ input: await sharp({ create: {
    width: change.width ?? 1, height: change.height ?? 1, channels: 4, background: "#ffffff",
  } }).png().toBuffer(), left: change.left, top: change.top }]);
  return `data:image/png;base64,${(await image.png().toBuffer()).toString("base64")}`;
}

function node(id: string, rect: UiNode["bounds"]): UiNode {
  return { ...makeNode(id), package: pkg, bounds: rect, text: null, resourceId: null, contentDesc: null,
    clickable: false, scrollable: false, enabled: true, visibleToUser: true, visibilityEvidence: "unknown", attributes: {}, children: [] };
}

function page(image: string | null, freshPath = false): UiSnapshot {
  const root = node("0", bounds(0, 0, 360, 640));
  const sidebar = node("0/0", bounds(0, 0, 280, 640));
  const draft = node("0/0/0", bounds(80, 290, 240, 380)); draft.text = "草稿箱"; draft.clickable = true;
  sidebar.children = [draft];
  const front = node("0/1", bounds(0, 0, 360, 640));
  const row = node(freshPath ? "0/1/1" : "0/1/0", bounds(120, 300, 180, 340)); row.clickable = true;
  const label = node(`${row.id}/0`, bounds(125, 305, 175, 335)); label.text = "收藏 13"; label.className = "android.widget.TextView";
  row.children = [label]; front.children = [row]; root.children = [sidebar, front];
  return { serial: "fixture", root, nodeCount: 6, xmlSize: 0, rawXml: null, screenshotDataUrl: image, error: null, warning: null,
    captureMode: "fast", inspectionSource: "uiautomator",
    captureGeometry: { screenshotSize: frame, beforeScreenshot: frame, afterScreenshot: frame, hierarchyRotation: 0 } };
}

async function harness(run: (api: {
  session: DebugSession; capture(): Promise<Record<string, unknown>>; tap(snapshotId: unknown, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  setPage(value: UiSnapshot): void; inputs(): number; path: string;
  timings: string[];
}) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "inspector-visual-confirmation-")), path = join(directory, "current.json");
  let current = page(await screenshot()), inputs = 0; const timings: string[] = [];
  const session = new DebugSession({ serial: "fixture", packageName: pkg, directory, snapshotPath: path, onEvent: () => {},
    observe: async (_serial, _package, _mode, _signal, _backend, timing) => {
      timings.push(timing ?? "parallel"); return { snapshot: structuredClone(current), target };
    }, input: async () => { inputs++; } });
  const sessionId = session.state.id;
  try {
    await run({ session, path, timings, inputs: () => inputs, setPage: value => { current = value; },
      capture: () => session.request({ name: "capture_ui", input: { sessionId } }),
      tap: (snapshotId, options = {}) => session.request({ name: "tap_node", input: {
        sessionId, snapshotId, nodeId: "0/1/0/0", target: "clickable-parent", ...options,
      } }) });
  } finally { session.stop(); await session.settled(); rmSync(directory, { recursive: true, force: true }); }
}

test("background drawer overlap returns fresh evidence and a visually confirmed parent tap sends exactly once", async () => {
  await harness(async api => {
    const first = await api.capture(); api.setPage(page(await screenshot(), true));
    const blocked = await api.tap(first.snapshotId);
    assert.equal(blocked.dispatchState, "not_sent"); assert.equal(api.inputs(), 0);
    const recovery = blocked.recovery as { kind: string; snapshotId: string; nodeId: string; targetNodeId: string; overlaps: { visibilityEvidence: string }[] };
    assert.equal(recovery.kind, "visual_confirmation_required"); assert.notEqual(recovery.snapshotId, first.snapshotId);
    assert.equal(recovery.snapshotId, blocked.snapshotId); assert.equal(recovery.nodeId, "0/1/1/0");
    assert.equal(recovery.targetNodeId, "0/1/1"); assert.equal(recovery.overlaps[0].visibilityEvidence, "unknown");
    assert.ok(readMcpSnapshot(api.path).snapshot.screenshotDataUrl);
    const sent = await api.tap(recovery.snapshotId, { nodeId: recovery.nodeId, visualConfirmation: confirmation });
    assert.equal(sent.isError, undefined); assert.equal(sent.dispatchState, "sent"); assert.equal(sent.verified, false);
    assert.equal(api.inputs(), 1);
    assert.deepEqual(api.timings, ["parallel", "parallel", "after-hierarchy", "parallel"]);
    const recorded = api.session.state.steps.at(-1)!.resolvedInput!;
    assert.equal(recorded.visualConfirmation!.referenceSnapshotId, recovery.snapshotId);
    assert.equal(recorded.visualConfirmation!.description, confirmation.description);
    assert.match(recorded.visualConfirmation!.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(recorded.visualConfirmation!.region, { left: 96, top: 276, width: 108, height: 88 });
    assert.deepEqual(recorded.visualConfirmation!.overlapNodeIds, ["0/0/0"]);
    const repeated = await api.tap(recovery.snapshotId, { nodeId: recovery.nodeId, visualConfirmation: confirmation });
    assert.equal(repeated.dispatchState, "not_sent"); assert.equal(api.inputs(), 1);
  });
});

test("a new foreground dialog over the target invalidates prior visual confirmation without sending input", async () => {
  await harness(async api => {
    const first = await api.capture();
    api.setPage(page(await screenshot({ left: 100, top: 280, width: 140, height: 100 })));
    const result = await api.tap(first.snapshotId, { visualConfirmation: confirmation });
    assert.equal(result.dispatchState, "not_sent"); assert.equal(api.inputs(), 0); assert.match(String(result.message), /画面已变化/);
  });
});

test("a newly exposed interactive overlap invalidates confirmation even if the pixels have not changed", async () => {
  await harness(async api => {
    const first = await api.capture(), next = page(await screenshot());
    const interceptor = node("0/2", bounds(110, 290, 190, 350)); interceptor.clickable = true; interceptor.text = "新浮层";
    next.root!.children.push(interceptor); api.setPage(next);
    const result = await api.tap(first.snapshotId, { visualConfirmation: confirmation });
    assert.equal(result.dispatchState, "not_sent"); assert.equal(api.inputs(), 0); assert.match(String(result.message), /重叠控件已变化/);
  });
});

test("unchanged overlap identities can change paths and enumeration order", async () => {
  await harness(async api => {
    const original = page(await screenshot());
    const other = node("0/0/1", bounds(100, 290, 220, 360)); other.clickable = true; other.text = "另一个背景入口";
    original.root!.children[0].children.push(other); api.setPage(original);
    const first = await api.capture(), next = structuredClone(original);
    const children = next.root!.children[0].children.reverse();
    children.forEach((child, index) => { child.id = `0/0/${index + 3}`; }); api.setPage(next);
    const result = await api.tap(first.snapshotId, { visualConfirmation: confirmation });
    assert.equal(result.dispatchState, "sent"); assert.equal(api.inputs(), 1);
  });
});

test("a single changed pixel in the padded region rejects, but unrelated video pixels outside it do not", async () => {
  for (const [point, allowed] of [[{ left: 100, top: 280 }, false], [{ left: 20, top: 500 }, true]] as const) {
    await harness(async api => {
      const first = await api.capture(); api.setPage(page(await screenshot(point)));
      const result = await api.tap(first.snapshotId, { visualConfirmation: confirmation });
      assert.equal(result.dispatchState, allowed ? "sent" : "not_sent"); assert.equal(api.inputs(), allowed ? 1 : 0);
    });
  }
});

test("missing, malformed and incorrectly sized screenshots cannot be used as visual evidence", async () => {
  for (const image of [null, "data:image/png;base64,AAAA", await screenshot(undefined, { ...frame, width: 180 })]) {
    await harness(async api => {
      const first = await api.capture(); api.setPage(page(image));
      const result = await api.tap(first.snapshotId, { visualConfirmation: confirmation });
      assert.equal(result.dispatchState, "not_sent"); assert.equal(api.inputs(), 0);
    });
  }
});

test("visual confirmation cannot bypass different packages, windows, disabled, hidden or ambiguous targets", async () => {
  for (const kind of ["package", "window", "passive-window", "disabled", "hidden", "duplicate", "moved"]) {
    await harness(async api => {
      const first = await api.capture(), next = page(await screenshot());
      const sidebar = next.root!.children[0], front = next.root!.children[1], row = front.children[0], label = row.children[0];
      if (kind === "package") sidebar.children[0].package = "com.other.app";
      if (kind === "window") { sidebar.attributes = { "window-id": "dialog" }; front.attributes = { "window-id": "main" }; }
      if (kind === "passive-window") {
        sidebar.children = []; sidebar.scrollable = true;
        sidebar.attributes = { "window-id": "dialog" }; front.attributes = { "window-id": "main" };
      }
      if (kind === "disabled") row.enabled = false;
      if (kind === "hidden") label.visibilityEvidence = "hidden";
      if (kind === "duplicate") { const copy = structuredClone(label); copy.id = "0/2"; next.root!.children.push(copy); }
      if (kind === "moved") { row.bounds!.left += 20; row.bounds!.right += 20; }
      api.setPage(next);
      const result = await api.tap(first.snapshotId, { visualConfirmation: confirmation });
      assert.equal(result.dispatchState, "not_sent", kind); assert.equal(api.inputs(), 0, kind);
      assert.equal(result.recovery, undefined, "hard failures must not offer overlap recovery");
    });
  }
});

test("scroll overlap can use visual evidence, but a nested scroller cannot", async () => {
  for (const nested of [false, true]) await harness(async api => {
    const next = page(await screenshot()), row = next.root!.children[1].children[0];
    row.text = "收藏列表"; row.clickable = false; row.scrollable = true; row.bounds = bounds(30, 250, 330, 600); row.children = [];
    if (nested) { const child = node(`${row.id}/0`, bounds(40, 300, 320, 550)); child.scrollable = true; row.children = [child]; }
    api.setPage(next); const first = await api.capture();
    const result = await api.session.request({ name: "scroll_node", input: { sessionId: api.session.state.id,
      snapshotId: first.snapshotId, nodeId: row.id, direction: "down", visualConfirmation: confirmation } });
    assert.equal(result.dispatchState, nested ? "not_sent" : "sent"); assert.equal(api.inputs(), nested ? 0 : 1);
  });
});

async function favoritesPage(change?: { left: number; top: number; width?: number; height?: number }) {
  const dimensions = { width: 1080, height: 2400, rotation: 0 as const };
  const result = page(await screenshot(change, dimensions));
  result.captureGeometry = { screenshotSize: dimensions, beforeScreenshot: dimensions, afterScreenshot: dimensions, hierarchyRotation: 0 };
  const root = node("0", bounds(0, 104, 1080, 2355));
  const list = node("0/0", bounds(0, 1426, 1080, 2355)); list.scrollable = true; list.resourceId = `${pkg}:id/recycler_view`;
  const bar = node("0/1", bounds(0, 1934, 1080, 2355)), row = node("0/1/0", bounds(0, 2218, 1080, 2355));
  row.children = [[0, 216], [216, 432], [648, 864], [864, 1080]].map(([left, right], i) => {
    const tab = node(`${row.id}/${i}`, bounds(left, 2218, right, 2355));
    tab.className = "androidx.appcompat.app.ActionBar$Tab"; tab.clickable = true; tab.selected = i === 3; return tab;
  });
  const camera = node("0/1/1", bounds(432, 2220, 643, 2355)); camera.clickable = true;
  bar.children = [row, camera];
  const background = node("0/2", bounds(450, 1700, 650, 1900)); background.clickable = true; background.text = "背景入口";
  root.children = [list, bar, background]; result.root = root; return result;
}

test("a favorites swipe ignores bottom-bar animation while recording a clipped viewport and confirmed corridor", async () => {
  await harness(async api => {
    api.setPage(await favoritesPage()); const first = await api.capture();
    const next = await favoritesPage({ left: 62, top: 2235, width: 930, height: 96 });
    next.root!.children[1].children[1].bounds = bounds(434, 2218, 645, 2355); api.setPage(next);
    const sent = await api.session.request({ name: "scroll_node", input: { sessionId: api.session.state.id,
      snapshotId: first.snapshotId, nodeId: "0/0", direction: "down", distance: 0.8, visualConfirmation: confirmation } });
    assert.equal(sent.dispatchState, "sent", String(sent.message)); assert.equal(api.inputs(), 1);
    const recorded = api.session.state.steps.at(-1)!.resolvedInput!;
    assert.equal(recorded.action.kind, "swipe");
    assert.deepEqual(recorded.scrollRegion!.viewport, { left: 0, top: 1426, right: 1080, bottom: 2218 });
    const roi = recorded.visualConfirmation!.region;
    assert.ok(roi.top + roi.height < 2218); assert.ok(roi.width < 1080);
    assert.deepEqual(sent.scrollRegion, recorded.scrollRegion);
    assert.equal(recorded.visualConfirmation!.overlapNodeIds.length, 1, "background conflict evidence is still retained");
  });
});

test("scroll confirmation still rejects changed corridor pixels and newly appearing transparent interceptors", async () => {
  for (const kind of ["pixel", "transparent", "transparent-child", "window-in-clipped-area", "descendant-window"]) await harness(async api => {
    api.setPage(await favoritesPage()); const first = await api.capture();
    const next = await favoritesPage(kind === "pixel" ? { left: 555, top: 1700 } : undefined);
    if (kind !== "pixel") {
      const foreign = kind.includes("window");
      const descendant = kind === "descendant-window" || kind === "transparent-child";
      const interceptor = node(descendant ? "0/0/0" : "0/3",
        foreign ? bounds(0, 2250, 1080, 2355) : bounds(550, 1700, 560, 1900)); interceptor.clickable = true;
      if (foreign) interceptor.attributes = { "window-id": "dialog" };
      if (descendant) next.root!.children[0].children.push(interceptor);
      else next.root!.children.push(interceptor);
    }
    api.setPage(next);
    const result = await api.session.request({ name: "scroll_node", input: { sessionId: api.session.state.id,
      snapshotId: first.snapshotId, nodeId: "0/0", direction: "down", visualConfirmation: confirmation } });
    assert.equal(result.dispatchState, "not_sent", kind); assert.equal(api.inputs(), 0, kind);
    assert.match(String(result.message), kind === "pixel" ? /画面已变化/ : kind.startsWith("transparent") ? /通道内的可操作控件已变化/ : /其他 App 或窗口/);
  });
});

test("a newly detected navigation row cannot silently shorten a previously confirmed gesture", async () => {
  await harness(async api => {
    const before = await favoritesPage(); before.root!.children[1].children[0].children.forEach(tab => { tab.selected = false; });
    api.setPage(before); const first = await api.capture(); api.setPage(await favoritesPage());
    const result = await api.session.request({ name: "scroll_node", input: { sessionId: api.session.state.id,
      snapshotId: first.snapshotId, nodeId: "0/0", direction: "down", visualConfirmation: confirmation } });
    assert.equal(result.dispatchState, "not_sent"); assert.equal(api.inputs(), 0);
    assert.match(String(result.message), /有效区域或底栏结构已变化/);
  });
});
