import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseUiHierarchy } from "../electron/capture/xml-tree";
import { loadTestReport } from "../electron/desktop/test-report";
import { debugToolSchemas } from "../shared/debug-protocol";
import { hasActionableHelperEvidence, hasSafeHelperObservationContext } from "../shared/helper-observation";
import { flattenNodes } from "../shared/tree-utils";
import type { DebugInputEvidence, DebugStep, UiSnapshot } from "../shared/types";
import { makeDebugReportExportFixture } from "./fixtures/debug-report-export";
import { helperEvidenceSnapshot } from "./fixtures/helper-evidence";

const frame = { width: 200, height: 400, rotation: 0 as const };
const receipt: DebugInputEvidence = { classification: "accepted", spawned: true, closed: true, exitCode: 0, signal: null,
  durationMs: 20, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false };
const swipe: NonNullable<DebugStep["resolvedInput"]> = {
  action: { kind: "swipe", fromX: 100, fromY: 302, toX: 100, toY: 98, durationMs: 350 }, frame,
  targetNodeId: "0/0", scrollRegion: { viewport: { left: 10, top: 30, right: 190, bottom: 370 },
    confirmationBounds: { left: 76, top: 74, right: 125, bottom: 327 }, excludedNavigationBounds: [] },
};

function overlay(snapshot: UiSnapshot, bounds = { x: 0, y: 0, width: 200, height: 20 }, type = "system") {
  const e = snapshot.helperObservation!;
  e.windowsBefore = [e.windowsBefore[0], { id: "8", type: type as "system", layer: 2, focused: false, active: false,
    packageName: "com.android.systemui", rootAvailable: true, bounds }];
  e.windowsAfter = structuredClone(e.windowsBefore);
}

function snapshot(packageName: string, serial: string, index: number) {
  const s = helperEvidenceSnapshot({ packageName, serial, ...frame, startedAt: 100 + index * 400 });
  const node = (index: number, className: string, text: string, rect: string, children = "", scrollable = false) =>
    `<node index="${index}" class="${className}" package="${packageName}" text="${text}" resource-id="" content-desc=""
      bounds="${rect}" bounds-screen="${rect}" visible-bounds="${rect}" window-id="7" visible-to-user="true"
      enabled="true" clickable="true" focusable="true" focused="false" scrollable="${scrollable}" selected="false">${children}</node>`;
  const xml = `<hierarchy rotation="0">${node(0, "Root", "", "[0,0][200,400]",
    node(0, "List", "列表", "[10,30][190,370]", node(0, "Button", "目标", "[40,80][160,160]"), true)
    + node(1, "Text", "完成", "[40,240][160,300]"))}</hierarchy>`;
  s.rawXml = xml; s.xmlSize = Buffer.byteLength(xml); s.root = parseUiHierarchy(xml).root;
  s.nodeCount = flattenNodes(s.root!).size; overlay(s);
  assert.equal(hasSafeHelperObservationContext(s), true);
  assert.equal(hasActionableHelperEvidence(s), false, "fixture must exercise region evidence");
  return s;
}

function hide(snapshot: UiSnapshot, text: string) {
  const node = [...flattenNodes(snapshot.root!).values()].find(node => node.text === text)!;
  node.visibleToUser = false; node.visibilityEvidence = "hidden";
  node.bounds = { left: 0, top: 0, right: 0, bottom: 0, raw: "[0,0][0,0]" };
  node.attributes!["visible-to-user"] = "false";
  node.attributes!.bounds = node.attributes!["visible-bounds"] = "[0,0][0,0]";
}

async function fixture(kind: "tap" | "back" | "scroll" | "scroll_until" = "tap", count = 3) {
  const f = await makeDebugReportExportFixture();
  const entry = f.report.steps[2];
  const document = JSON.parse(readFileSync(join(f.directory, f.report.snapshots[0].tree!.path), "utf8"));
  while (f.report.snapshots.length < count) {
    const index = f.report.snapshots.length;
    f.report.snapshots.push({ ...structuredClone(f.report.snapshots[0]),
      snapshotId: `00000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`,
      capturedAt: `2026-10-12T09:00:0${index}.000Z` });
  }
  const snapshots = f.report.snapshots.map((_, i) => snapshot(f.report.session.packageName, f.report.session.serial, i));
  const ids = f.report.snapshots.map(s => s.snapshotId);
  const save = () => {
    for (const [i, evidence] of f.report.snapshots.entries()) {
      evidence.source = "accessibility-helper"; evidence.screenshot = null;
      evidence.tree = f.artifact(Buffer.from(JSON.stringify({ ...document, snapshotId: evidence.snapshotId,
        capturedAt: evidence.capturedAt, snapshot: snapshots[i] })), "json");
    }
    f.save();
  };
  entry.step.action = kind === "scroll_until" ? kind : "perform_ui_step";
  entry.step.time = f.report.session.startedAt;
  entry.finishedAt = f.report.session.updatedAt = `2026-10-12T09:00:0${count}.000Z`;
  const request = { sessionId: f.report.session.id, requestId: "abcdef00-0000-4000-8000-000000000099", backend: "accessibility-helper" };
  entry.step.beforeId = ids[0]; entry.before = { snapshotId: ids[0], freshness: "current", reason: null };
  entry.step.afterId = ids.at(-1); entry.after = { snapshotId: ids.at(-1)!, freshness: "current", reason: null };
  entry.step.dispatchState = "sent"; entry.step.verified = entry.verified = true;
  if (kind === "scroll_until") {
    entry.step.input = debugToolSchemas.scroll_until.parse({ ...request, target: { selector: { className: "List" } },
      direction: "down", until: { selector: { text: "目标" }, kind: "target" } });
    entry.step.scrollTask = { stopReason: "target_found", observationIds: ids,
      iterations: [{ index: 1, startedAt: entry.step.time, durationMs: 1000, beforeId: ids[0], afterId: ids[1],
        dispatchState: "sent", progress: "changed", inputEvidence: receipt, resolvedInput: structuredClone(swipe) }],
      confirmation: { firstSnapshotId: ids[count - 2], secondSnapshotId: ids[count - 1], kind: "target" } };
  } else {
    entry.step.input = debugToolSchemas.perform_ui_step.parse({ ...request,
      ...(kind !== "back" ? { target: { selector: kind === "scroll" ? { className: "List" } : { text: "目标" } } } : {}),
      action: kind === "scroll" ? { kind, direction: "down" } : { kind }, expect: { selector: { text: "完成" }, state: "visible" } });
    entry.step.inputEvidence = receipt;
    entry.step.resolvedInput = kind === "scroll" ? structuredClone(swipe) : kind === "back" ? { action: { kind }, frame }
      : { action: { kind, x: 100, y: 120 }, frame, targetNodeId: "0/0/0" };
  }
  f.report.steps = [entry]; f.report.session.droppedSteps = 2; save();
  return { ...f, entry, snapshots, ids, save, saveManifest: f.save,
    result: async () => (await loadTestReport(f.file)).debug!.steps.at(-1)! };
}

test("Helper region imports preserve clear tap, swipe and Back assertions around a system bar", async () => {
  for (const kind of ["tap", "scroll", "back", "scroll_until"] as const) {
    const f = await fixture(kind);
    try { assert.equal((await f.result()).verified, true, kind); }
    finally { f.cleanup(); }
  }
});

test("Helper import validates touch margin, entire swipe corridor and Back-consuming windows", async () => {
  for (const kind of ["tap", "scroll", "back", "scroll_until"] as const) {
    const f = await fixture(kind);
    try {
      const rect = kind === "tap" ? { x: 75, y: 100, width: 5, height: 40 }
        : kind === "back" ? { x: 0, y: 380, width: 200, height: 20 } : { x: 70, y: 190, width: 10, height: 20 };
      overlay(f.snapshots[0], rect, kind === "back" ? "input_method" : "system"); f.save();
      const result = await f.result();
      assert.equal(result.verified, null, kind); assert.equal(result.step.dispatchState, "sent");
    } finally { f.cleanup(); }
  }
});

test("Helper absent assertions never treat a covered hidden match as absent", async () => {
  const f = await fixture();
  try {
    (f.entry.step.input.expect as { state: string }).state = "absent";
    hide(f.snapshots[2], "完成"); f.save(); assert.equal((await f.result()).verified, true);
    overlay(f.snapshots[2], { x: 40, y: 240, width: 120, height: 60 }); f.save();
    assert.equal((await f.result()).verified, null);
  } finally { f.cleanup(); }
});

test("Helper imports require actual input region and original service identity when any frame has local occlusion", async () => {
  const mutations = [
    (f: Awaited<ReturnType<typeof fixture>>) => { delete f.entry.step.resolvedInput; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.entry.step.resolvedInput!.targetNodeId = "0/1"; },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      const target = f.snapshots[0].root!.children[0].children[0]; target.clickable = false; target.attributes!.clickable = "false";
    },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.entry.step.resolvedInput!.frame.width = 201; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.snapshots[2].helperObservation!.serviceInstanceId = "10000000-0000-4000-8000-000000000099"; },
    (f: Awaited<ReturnType<typeof fixture>>) => { overlay(f.snapshots[2], { x: 40, y: 240, width: 120, height: 60 }); },
  ];
  for (const mutate of mutations) {
    const f = await fixture();
    try { mutate(f); f.save(); const result = await f.result(); assert.equal(result.verified, null); assert.equal(result.step.dispatchState, "sent"); }
    finally { f.cleanup(); }
  }
  const f = await fixture("scroll");
  try { delete f.entry.step.resolvedInput!.scrollRegion; f.save(); assert.equal((await f.result()).verified, null); }
  finally { f.cleanup(); }
});

test("Helper imports preserve older whole-window-safe evidence without newly required region fields", async () => {
  const f = await fixture();
  try {
    for (const s of f.snapshots) {
      s.helperObservation!.windowsBefore.splice(1); s.helperObservation!.windowsAfter.splice(1);
      assert.equal(hasActionableHelperEvidence(s), true);
    }
    delete f.entry.step.resolvedInput; f.save(); assert.equal((await f.result()).verified, true);
  } finally { f.cleanup(); }
});

test("Helper swipe imports reject a narrowed corridor and a gesture inconsistent with the request", async () => {
  for (const kind of ["scroll", "scroll_until"] as const) {
    const f = await fixture(kind);
    try {
      const resolved = kind === "scroll" ? f.entry.step.resolvedInput! : f.entry.step.scrollTask!.iterations[0].resolvedInput!;
      resolved.scrollRegion!.confirmationBounds = { left: 100, top: 98, right: 101, bottom: 303 };
      overlay(f.snapshots[0], { x: 110, y: 190, width: 10, height: 20 }); f.save();
      assert.equal((await f.result()).verified, null, "stored narrow bounds cannot hide a corridor overlap");
      resolved.scrollRegion = structuredClone(swipe.scrollRegion); overlay(f.snapshots[0]);
      if (kind === "scroll") (f.entry.step.input.action as { direction: string }).direction = "up";
      else f.entry.step.input.direction = "up";
      f.save(); assert.equal((await f.result()).verified, null, "actual gesture must match requested direction");
    } finally { f.cleanup(); }
  }
});

test("Helper parent-tap imports protect the semantic anchor separately from the touch point", async () => {
  const f = await fixture();
  try {
    const before = f.snapshots[0], parent = before.root!.children[0].children[0];
    const label = structuredClone(parent); label.id += "/0"; label.text = "标签"; label.clickable = false;
    label.bounds = { left: 40, top: 80, right: 160, bottom: 100, raw: "[40,80][160,100]" };
    Object.assign(label.attributes!, { text: "标签", clickable: "false", bounds: label.bounds.raw,
      "visible-bounds": label.bounds.raw, "bounds-screen": label.bounds.raw });
    parent.children.push(label); before.nodeCount++;
    f.entry.step.input.target = { selector: { text: "标签" }, target: "clickable-parent" };
    f.entry.step.resolvedInput!.anchorNodeId = label.id; f.save();
    assert.equal((await f.result()).verified, true);
    overlay(before, { x: 50, y: 80, width: 10, height: 10 }); f.save();
    assert.equal((await f.result()).verified, null, "unobscured parent center does not prove its covered label");
  } finally { f.cleanup(); }
});

test("Helper scroll imports use nested parent clipping when confirming an end marker", async () => {
  const f = await fixture("scroll_until");
  try {
    f.entry.step.scrollTask!.iterations = []; f.entry.step.dispatchState = "not_sent";
    for (const s of f.snapshots) {
      const list = s.root!.children[0], target = list.children[0], group = structuredClone(target);
      group.text = null; group.className = "Group"; group.clickable = false;
      group.bounds = { left: 10, top: 30, right: 30, bottom: 50, raw: "[10,30][30,50]" };
      Object.assign(group.attributes!, { text: "", class: "Group", clickable: "false", bounds: group.bounds.raw,
        "bounds-screen": group.bounds.raw, "visible-bounds": group.bounds.raw });
      target.id += "/0"; group.children = [target]; list.children = [group]; s.nodeCount++;
      assert.equal(hasSafeHelperObservationContext(s), true, "clipping is a semantic assertion check, not malformed evidence");
    }
    f.save(); assert.equal((await f.result()).verified, null, "marker outside its ordinary parent's window clip is not visible proof");
  } finally { f.cleanup(); }
});

test("Helper scroll imports check both confirmation frames and hidden loading candidates", async () => {
  for (const index of [1, 2]) {
    const f = await fixture("scroll_until");
    try {
      overlay(f.snapshots[index], { x: 40, y: 80, width: 120, height: 80 }); f.save();
      assert.equal((await f.result()).verified, null);
    } finally { f.cleanup(); }
  }
  const f = await fixture("scroll_until");
  try {
    f.entry.step.input.loading = { text: "目标" }; hide(f.snapshots[2], "目标");
    overlay(f.snapshots[2], { x: 40, y: 80, width: 120, height: 80 }); f.save();
    assert.equal((await f.result()).verified, null);
  } finally { f.cleanup(); }
});

test("Helper multiple-scroll imports bind each iteration without treating the latest before frame as earliest", async () => {
  const f = await fixture("scroll_until", 4);
  try {
    const p = f.entry.step.scrollTask!;
    p.iterations.push({ ...structuredClone(p.iterations[0]), index: 2, startedAt: f.report.snapshots[1].capturedAt,
      beforeId: f.ids[1], afterId: f.ids[2] });
    f.entry.step.beforeId = f.ids[1]; f.entry.before.snapshotId = f.ids[1]; f.save();
    assert.equal((await f.result()).verified, true);
    overlay(f.snapshots[0], { x: 70, y: 190, width: 10, height: 20 }); f.save();
    assert.equal((await f.result()).verified, null, "an earlier gesture remains part of the proof");
  } finally { f.cleanup(); }
});

test("Helper read-only resume reuses original input proof and downgrades missing retained evidence", async () => {
  const f = await fixture("tap", 4);
  try {
    f.entry.step.afterId = f.ids[2]; f.entry.after.snapshotId = f.ids[2]; f.entry.finishedAt = "2026-10-12T09:00:03.000Z";
    const resumed = structuredClone(f.entry); resumed.step.id = 4; resumed.step.action = "resume_ui_step";
    resumed.step.time = "2026-10-12T09:00:03.000Z"; resumed.finishedAt = "2026-10-12T09:00:04.000Z";
    resumed.step.input = debugToolSchemas.resume_ui_step.parse({ sessionId: f.report.session.id, requestId: f.entry.step.input.requestId });
    resumed.step.beforeId = f.ids[3]; resumed.before.snapshotId = f.ids[3];
    resumed.step.afterId = f.ids[3]; resumed.after.snapshotId = f.ids[3];
    delete resumed.step.resolvedInput; delete resumed.step.inputEvidence;
    f.report.steps.push(resumed); f.report.session.totalSteps = 4; f.save();
    assert.equal((await f.result()).verified, true);
    f.report.snapshots[0].tree = null; f.saveManifest();
    const result = await f.result(); assert.equal(result.verified, null); assert.equal(result.step.dispatchState, "sent");
  } finally { f.cleanup(); }
});

test("Helper scroll resume preserves iteration regions and requires two fresh clear confirmation trees", async () => {
  const f = await fixture("scroll_until", 5);
  try {
    const p = f.entry.step.scrollTask!;
    p.observationIds = f.ids.slice(0, 3); p.confirmation = { firstSnapshotId: f.ids[1], secondSnapshotId: f.ids[2], kind: "target" };
    f.entry.step.afterId = f.ids[2]; f.entry.after.snapshotId = f.ids[2]; f.entry.finishedAt = "2026-10-12T09:00:03.000Z";
    const resumed = structuredClone(f.entry); resumed.step.id = 4; resumed.step.action = "resume_ui_step";
    resumed.step.time = "2026-10-12T09:00:03.000Z"; resumed.finishedAt = "2026-10-12T09:00:05.000Z";
    resumed.step.input = debugToolSchemas.resume_ui_step.parse({ sessionId: f.report.session.id, requestId: f.entry.step.input.requestId });
    resumed.step.beforeId = f.ids[3]; resumed.before.snapshotId = f.ids[3];
    resumed.step.afterId = f.ids[4]; resumed.after.snapshotId = f.ids[4];
    resumed.step.scrollTask!.observationIds = [...f.ids];
    resumed.step.scrollTask!.confirmation = { firstSnapshotId: f.ids[3], secondSnapshotId: f.ids[4], kind: "target" };
    f.report.steps.push(resumed); f.report.session.totalSteps = 4; f.save();
    assert.equal((await f.result()).verified, true);
    overlay(f.snapshots[3], { x: 40, y: 80, width: 120, height: 80 }); f.save();
    assert.equal((await f.result()).verified, null, "one covered fresh frame cannot be replaced by the old confirmation");
    overlay(f.snapshots[3]); f.save(); f.report.snapshots[0].tree = null; f.saveManifest();
    const result = await f.result(); assert.equal(result.verified, null); assert.equal(result.step.dispatchState, "sent");
  } finally { f.cleanup(); }
});
