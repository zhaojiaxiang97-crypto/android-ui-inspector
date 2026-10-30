import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { InspectionMode, InspectionModeState } from "../shared/inspection-mode";
import type { QmlGroupImage, UiSnapshot, ViewRefreshResult } from "../shared/types";
import type { InspectionModePort, InspectionPort } from "../src/platform/desktop-services";
import { InspectionModePreferences } from "../src/components/InspectionModePreferences";
import { useInspectionMode } from "../src/features/inspection/useInspectionMode";
import { useInspectionWorkspace } from "../src/features/inspection/useInspectionWorkspace";
import { makeNode } from "./fixtures";

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const check = (value: unknown, message: string) => { if (!value) throw new Error(`Inspection mode: ${message}`); };
async function until(condition: () => boolean, message: string) {
  for (let i = 0; i < 120; i++) { if (condition()) return; await tick(); }
  check(false, message);
}

export async function verifyInspectionModeSettings() {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), checks: string[] = [];
  const loads: ReturnType<typeof deferred<InspectionModeState>>[] = [];
  const saves: { mode: InspectionMode; reply: ReturnType<typeof deferred<InspectionModeState>> }[] = [];
  let publish!: (state: InspectionModeState) => void, subscriptions = 0;
  const modeApi: InspectionModePort = {
    getInspectionMode: () => { const reply = deferred<InspectionModeState>(); loads.push(reply); return reply.promise; },
    setInspectionMode: mode => { const reply = deferred<InspectionModeState>(); saves.push({ mode, reply }); return reply.promise; },
    onInspectionMode: listener => { publish = listener; subscriptions++; return () => { subscriptions--; }; },
  };
  const node = makeNode("0"), child = makeNode("0/0"); node.children = [child];
  node.attributes = { "view-ref": "View@1", "debug-process-id": "1", "debug-window-name": "fixture" };
  const image: QmlGroupImage = { dataUrl: "data:image/png;base64,aGVsbG8=", size: { width: 4, height: 4 }, capturedAt: "2026-10-15T00:00:00Z" };
  const snapshot: UiSnapshot = { serial: "fixture", root: node, nodeCount: 2, xmlSize: 0,
    rawXml: null, screenshotDataUrl: image.dataUrl, warning: null, error: null, inspectionSource: "debug-hybrid" };
  const lateGroup = deferred<QmlGroupImage | null>(), lateRefresh = deferred<ViewRefreshResult>();
  let groupCalls = 0, refreshCalls = 0;
  const canceled: string[] = [];
  const api: InspectionPort = {
    inspectDevice: async () => snapshot, cancelInspection: async id => { canceled.push(id); },
    captureGroup: async (_requestId, nodeId) => { groupCalls++; return nodeId === node.id ? image : lateGroup.promise; },
    refreshViewNode: () => { refreshCalls++; return lateRefresh.promise; },
    showLayerMenu: async () => null, onInspectionProgress: () => () => {}, onInspectionPreview: () => () => {},
  };
  let workspace!: ReturnType<typeof useInspectionWorkspace>, settings!: ReturnType<typeof useInspectionMode>;
  function Probe({ port }: { port?: InspectionModePort }) {
    workspace = useInspectionWorkspace({ api });
    settings = useInspectionMode(port, workspace.invalidateLiveInspection, workspace.inspectionLoading || Boolean(workspace.viewRefreshingNodeId));
    return <div className="app-shell"><InspectionModePreferences preference={settings} />
      {workspace.requiresRecapture && <p data-recapture role="status">采集模式已更改，请重新采集。</p>}</div>;
  }
  const toggle = () => host.querySelector<HTMLInputElement>('[aria-label="启用 SDK 增强"]')!;
  const clickToggle = () => flushSync(() => toggle().click());
  try {
    flushSync(() => root.render(<Probe port={modeApi} />));
    check(toggle().disabled && !toggle().checked, "first render must remain standard and disabled while loading");
    clickToggle(); check(saves.length === 0, "loading checkbox started a save");
    loads[0].reject(new Error("fixture read failure"));
    await until(() => Boolean(host.querySelector('[role="alert"]')), "read failure is not visible");
    check(toggle().disabled, "read failure enabled a setting with unknown state");
    flushSync(() => host.querySelector<HTMLButtonElement>(".preferences-actions button")!.click());
    loads[1].resolve({ mode: "standard", revision: 0, busy: false });
    await until(() => !toggle().disabled, "retry did not enable the confirmed standard mode");
    checks.push("load and retry gate edits; read failure stays visible");

    let capture!: Promise<UiSnapshot | null>;
    flushSync(() => { capture = workspace.inspectDevice("fixture"); }); await capture;
    await until(() => workspace.snapshot === snapshot && !workspace.inspectionLoading, "fixture capture did not settle");
    await workspace.requestGroup(node); await tick();
    check(workspace.availableGroupImages[0]?.image === image, "successful group image missing");
    const old = workspace, pendingGroup = workspace.requestGroup(child);
    let pendingRefresh!: Promise<void>;
    flushSync(() => { pendingRefresh = workspace.refreshViewNode(node); });
    check(toggle().disabled && refreshCalls === 1, "local refresh did not disable mode edits");
    // Simulate a cross-window event racing a reply from the previous revision.
    flushSync(() => publish({ mode: "sdk-enhanced", revision: 1, busy: false }));
    check(workspace.snapshot === snapshot && workspace.selectedNode === old.selectedNode && workspace.treeSession === old.treeSession,
      "mode event replaced the current document, selection or browsing session");
    check(!workspace.groupRequestId && !workspace.viewLiveRequestId && !workspace.viewRefreshingNodeId && Boolean(host.querySelector("[data-recapture]")),
      "mode event retained live capabilities or failed to show recapture feedback");
    check(workspace.availableGroupImages[0]?.image === image && workspace.snapshotForStorage()!.layerGroupImages?.[0]?.image === image,
      "mode event lost successful images from display or export");
    lateGroup.resolve(image); lateRefresh.resolve({ nodes: [{ ...node, text: "obsolete" }], failures: [] });
    check(await pendingGroup === null, "late group result was accepted"); await pendingRefresh; await tick();
    check(workspace.snapshot === snapshot && workspace.viewRefreshStatus === null && workspace.availableGroupImages.length === 1,
      "late refresh/group altered the retained document");
    check(await old.requestGroup(child) === null, "retained old group callback was accepted");
    await old.refreshViewNode(node);
    check(groupCalls === 2 && refreshCalls === 1 && old.refreshScopesForNode(node).every(scope => !scope.available),
      "retained callback started old work or advertised stale refresh availability");
    check(canceled.length === 1, "mode invalidation did not cancel the original refresh exactly once");
    checks.push("revision revokes live capabilities and stale callbacks; snapshot, selection, images and export remain intact");

    check(toggle().checked && !toggle().disabled, "event-confirmed enhanced mode was not displayed");
    clickToggle(); check(toggle().disabled && toggle().checked && saves[0]?.mode === "standard", "save was optimistic or not serialized");
    clickToggle(); check(saves.length === 1, "pending save was duplicated");
    saves[0].reply.reject(new Error("fixture save failure"));
    await until(() => !toggle().disabled, "save failure left checkbox stuck");
    check(toggle().checked && host.querySelector('[role="alert"]')?.textContent === "fixture save failure", "failed save changed confirmed state or hid its error");
    flushSync(() => publish({ mode: "sdk-enhanced", revision: 1, busy: true }));
    clickToggle(); check(toggle().disabled && saves.length === 1, "busy event allowed editing");
    flushSync(() => publish({ mode: "sdk-enhanced", revision: 1, busy: false }));
    clickToggle();
    flushSync(() => publish({ mode: "standard", revision: 2, busy: true }));
    saves[1].reply.resolve({ mode: "standard", revision: 2, busy: false });
    await until(() => !settings.saving, "successful save did not settle");
    check(toggle().disabled && !toggle().checked, "save reply overwrote a newer busy event");
    flushSync(() => publish({ mode: "standard", revision: 2, busy: false }));
    checks.push("save failure preserves confirmed choice; busy events disable editing; replies cannot undo newer busy state");

    flushSync(() => { capture = workspace.inspectDevice("fixture"); }); await capture;
    await until(() => !workspace.inspectionLoading, "recapture did not finish");
    check(!workspace.requiresRecapture && workspace.viewLiveRequestId && !host.querySelector("[data-recapture]"), "recapture did not restore the new live session");
    flushSync(() => root.render(<Probe />));
    check(toggle().disabled && !toggle().checked && host.textContent?.includes("不支持修改采集模式"), "legacy runtime pretended to change settings");
    check(subscriptions === 0 && workspace.snapshot === snapshot, "mode port replacement lost the snapshot or leaked events");
    checks.push("recapture clears warning; legacy runtime disables settings without losing the snapshot");
    return { passed: true, checks, phoneOperations: 0 };
  } finally { flushSync(() => root.unmount()); host.remove(); }
}
