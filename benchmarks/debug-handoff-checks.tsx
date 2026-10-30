import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import fixture from "../tests/fixtures/debug-handoff-snapshot.json";
import { mcpStopReasons, type McpStopSource } from "../shared/types";
import type { AppMenuAction, AppMenuState, DebugSessionEvent, DebugSessionState, InspectionPreview, UiSnapshot } from "../shared/types";
import { flattenNodes } from "../shared/tree-utils";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

// Real 70-node parent/child geometry, allowlisted into a public fixture. No phone IO.
export async function verifyDebugHandoff() {
  const previousApi = window.electronApi;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const initialState = deferred<DebugSessionState | null>();
  const grants: ReturnType<typeof deferred<DebugSessionState | null>>[] = [];
  const captures: Array<ReturnType<typeof deferred<UiSnapshot>> & { id: string }> = [];
  const shares: ReturnType<typeof deferred<{ shared: boolean; snapshotId: string | null; error: string | null }>>[] = [];
  const cancelled: string[] = [];
  const stopRequests: Array<McpStopSource | undefined> = [];
  let menu: ((action: AppMenuAction) => void) | null = null;
  let menuState: AppMenuState | null = null;
  let event: ((event: DebugSessionEvent) => void) | null = null;
  let preview: ((event: InspectionPreview) => void) | null = null;
  const snap = structuredClone(fixture) as UiSnapshot;
  const targetId = [...flattenNodes(snap.root!).values()].find(node => node.text === "播放设置")!.id;
  const history = { ...snap, nodeCount: 71 };
  const state: DebugSessionState = { id: "session-one", serial: snap.serial, packageName: "com.example.sanitized",
    active: true, busy: false, expiresAt: "2099-01-01T00:00:00Z", steps: [], evidencePath: null };
  window.electronApi = {
    ...previousApi,
    runtime: { sandboxed: true, contextIsolated: true, nativeMenu: true },
    probeAdb: async () => ({ adbPath: "fixture", adbVersion: "fixture", error: null,
      devices: [{ serial: snap.serial, state: "device", model: "fixture", androidVersion: "fixture", product: null, transportId: null }] }),
    loadSnapshots: async () => ({ error: null, snapshots: [{ id: "history", capturedAt: "2026-01-01T00:00:00Z", savedAt: "2026-01-01T00:00:00Z", snapshot: history }] }),
    updateAppMenu: async value => { menuState = value; },
    onAppMenuAction: callback => { menu = callback; return () => { menu = null; }; },
    onInspectionProgress: () => () => {},
    onInspectionPreview: callback => { preview = callback; return () => { preview = null; }; },
    inspectDevice: (_serial, id) => { const pending = { ...deferred<UiSnapshot>(), id }; captures.push(pending); return pending.promise; },
    cancelInspection: async id => { cancelled.push(id); },
    getDebugSession: () => initialState.promise,
    onDebugSession: callback => { event = callback; return () => { event = null; }; },
    startDebugSession: () => { const pending = deferred<DebugSessionState | null>(); grants.push(pending); return pending.promise; },
    stopMcpSharing: async source => { stopRequests.push(source); },
    shareMcpSnapshot: () => { const pending = deferred<{ shared: boolean; snapshotId: string | null; error: string | null }>(); shares.push(pending); return pending.promise; },
  };
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(`Debug handoff: ${message}`); };
  const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const settle = async () => { await tick(); await tick(); };
  const send = (value: DebugSessionEvent) => flushSync(() => event?.(value));
  const command = (type: AppMenuAction["type"]) => flushSync(() => menu?.({ type } as AppMenuAction));
  const currentMenu = () => menuState as AppMenuState | null;
  const viewHistory = () => flushSync(() => host.querySelector<HTMLButtonElement>(".snapshot-history-item")!.click());
  try {
    flushSync(() => root.render(<App />));
    await settle();
    check(!host.querySelector(".inspection-active") && menuState !== null, "fixture must start on connection home");
    const beforeGrantStops = stopRequests.length;
    check(stopRequests.at(-1) === "snapshot-change", "initial workspace cleanup must identify its source");
    command("debug-start");
    check(grants.length === 1, "grant request missing");
    send({ state });
    send({ state, snapshot: snap, selectedNodeId: targetId });
    initialState.resolve(null);
    grants[0].resolve({ ...state, busy: true });
    await settle();
    check(host.querySelector(".inspection-active") && host.querySelector(".ui-tree-scroll"), "authorized snapshot did not enter the workspace");
    check(host.querySelector(".floating-inspector")?.textContent?.includes("播放设置"), "event selection did not reach properties");
    check(currentMenu()?.inspecting && currentMenu()?.hasSnapshot && !currentMenu()?.capturing, "native menu did not follow workspace");
    check(host.querySelector(".debug-drawer summary")?.getAttribute("title") === "AI 已授权", "late initial/start reply replaced newer state");
    check(stopRequests.length === beforeGrantStops, "adopting a live snapshot unexpectedly asked the backend to revoke");

    const nextLive = { ...snap };
    send({ state: { ...state, busy: true } });
    send({ state, snapshot: nextLive, selectedNodeId: targetId });
    await settle();
    check(stopRequests.length === beforeGrantStops && host.querySelector(".debug-stop"), "second live capture or busy event unexpectedly revoked the session");

    command("mcp-stop");
    check(stopRequests.length === beforeGrantStops + 1 && stopRequests.at(-1) === "explicit", "explicit stop did not reach the backend exactly once with its source");
    send({ state: { ...state, active: false, stopReason: mcpStopReasons.explicit } });
    send({ state, snapshot: { ...snap, nodeCount: 999 } });
    await settle();
    check(!host.querySelector(".debug-stop") && !host.textContent?.includes("999 nodes"), "queued stopped-session event restored authorization or data");
    check(host.textContent?.includes(`已停止：${mcpStopReasons.explicit}`), "authoritative stop reason missing from the drawer");

    command("capture");
    const old = captures.at(-1)!;
    flushSync(() => preview?.({ requestId: old.id, phase: "tree", snapshot: snap }));
    await settle();
    viewHistory();
    check(stopRequests.includes("history"), "history stop source missing");
    old.reject(new Error("obsolete capture failure"));
    flushSync(() => preview?.({ requestId: old.id, phase: "tree", snapshot: { ...snap, nodeCount: 998 } }));
    await settle();
    check(cancelled.includes(old.id) && host.textContent?.includes("71 nodes"), "history did not take ownership of the capture");
    check(!host.textContent?.includes("obsolete capture failure") && !host.textContent?.includes("998 nodes"), "late capture entered history");

    const nextState = { ...state, id: "session-two" };
    command("debug-start");
    check(grants.length === 2, "new authorization request missing");
    send({ state: nextState, snapshot: snap, selectedNodeId: targetId });
    grants[1].resolve(nextState);
    await settle();
    check(host.querySelector(".debug-stop") && host.textContent?.includes("70 nodes") && !currentMenu()?.capturing,
      "explicit new authorization did not adopt its snapshot");
    check(!host.textContent?.includes(`已停止：${mcpStopReasons.explicit}`), "new grant retained the previous stop explanation");
    send({ state: nextState, snapshot: { ...snap, serial: "other-device", nodeCount: 996 } });
    check(!host.textContent?.includes("996 nodes"), "mismatched device snapshot accepted");

    command("mcp-stop");
    await settle();
    command("mcp-share");
    check(shares.length === 1, "share request missing");
    viewHistory();
    shares[0].reject(new Error("obsolete sharing failure"));
    await settle();
    check(!host.textContent?.includes("MCP 共享失败"), "late sharing error replaced history feedback");
    command("mcp-share");
    check(shares.length === 2, "second share request missing");
    viewHistory();
    shares[1].resolve({ shared: true, snapshotId: "obsolete-share", error: null });
    await settle();
    check(!currentMenu()?.mcpSharing && !host.textContent?.includes("MCP 已共享这一份快照"), "late sharing success restored a revoked share");

    command("debug-start");
    check(grants.length === 3, "third grant request missing");
    command("home");
    check(stopRequests.includes("home"), "home stop source missing");
    const lateState = { ...state, id: "late-grant" };
    grants[2].resolve(lateState);
    send({ state: lateState, snapshot: snap });
    await settle();
    check(!host.querySelector(".debug-stop") && !host.querySelector(".inspection-active"), "late approval restored a closed workspace");
    const queued = event as ((value: DebugSessionEvent) => void) | null;
    flushSync(() => root.unmount());
    check(event === null && preview === null && menu === null, "subscriptions leaked after unmount");
    queued?.({ state: nextState, snapshot: snap });
    return { checks: ["sanitized real 70-node home → grant → event → tree/properties/native menu", "late initial and grant replies cannot overwrite newer events",
      "first/second live snapshot and busy events never request backend revoke", "explicit stop reaches backend once; authoritative stop reason survives queued events and clears on new grant", "history/home stop sources identified; history ignores late capture", "explicit new authorization adopts snapshot and rejects device mismatch",
      "late sharing failure/success cannot overwrite new workspace or revoke state", "home rejects late approval; unmount unsubscribes"] };
  } finally {
    if (host.childNodes.length) flushSync(() => root.unmount());
    host.remove();
    window.electronApi = previousApi;
  }
}
