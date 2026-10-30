import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { InspectionPort } from "../src/platform/desktop-services";
import { useInspectionWorkspace } from "../src/features/inspection/useInspectionWorkspace";
import type { InspectionPreview, InspectionProgress, UiSnapshot, ViewRefreshResult } from "../shared/types";
import { makeNode } from "./fixtures";

function check(value: unknown, message: string) {
  if (!value) throw new Error(`Inspection port replacement: ${message}`);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function until(predicate: () => boolean, message: string) {
  for (let frame = 0; frame < 120; frame++) {
    if (predicate()) return;
    await tick();
  }
  check(false, message);
}

function port() {
  const capture = deferred<UiSnapshot>(), refresh = deferred<ViewRefreshResult>();
  const canceled: string[] = [];
  let captureId = "", activeSubscriptions = 0;
  let progress: ((event: InspectionProgress) => void) | undefined;
  let preview: ((event: InspectionPreview) => void) | undefined;
  const api: InspectionPort = {
    inspectDevice: (_serial, id) => { captureId = id; return capture.promise; },
    cancelInspection: async id => { canceled.push(id); },
    captureGroup: async () => null,
    refreshViewNode: () => refresh.promise,
    showLayerMenu: async () => null,
    onInspectionProgress: callback => { progress = callback; activeSubscriptions++; return () => { activeSubscriptions--; }; },
    onInspectionPreview: callback => { preview = callback; activeSubscriptions++; return () => { activeSubscriptions--; }; },
  };
  return { api, capture, refresh, canceled, get captureId() { return captureId; }, get activeSubscriptions() { return activeSubscriptions; },
    lateEvents(snapshot: UiSnapshot) {
      progress?.({ requestId: captureId, stage: "old-port-progress", elapsedMs: 1 });
      preview?.({ requestId: captureId, phase: "tree", snapshot });
    } };
}

export async function verifyInspectionPortReplacement() {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let workspace!: ReturnType<typeof useInspectionWorkspace>;
  function Probe({ api }: { api: InspectionPort }) { workspace = useInspectionWorkspace({ api }); return null; }
  const first = port(), second = port(), third = port();
  const node = makeNode("0");
  node.attributes = { "debug-process-id": "fixture", "debug-window-name": "fixture-window", "view-ref": "View@1" };
  const snapshot: UiSnapshot = { serial: "fixture", root: node, nodeCount: 1, xmlSize: 0,
    rawXml: null, screenshotDataUrl: null, warning: null, error: null, inspectionSource: "debug-hybrid" };
  try {
    flushSync(() => root.render(<Probe api={first.api} />));
    let oldCapture!: Promise<UiSnapshot | null>;
    flushSync(() => { oldCapture = workspace.inspectDevice("fixture"); });
    check(workspace.inspectionLoading, "capture never entered busy state");
    flushSync(() => root.render(<Probe api={second.api} />));
    await until(() => !workspace.inspectionLoading && workspace.snapshot === null, "new port retained old capture state");
    check(first.canceled.length === 1 && first.canceled[0] === first.captureId && second.canceled.length === 0,
      "old capture was not canceled on its original port exactly once");
    check(first.activeSubscriptions === 0 && second.activeSubscriptions === 2, "subscriptions did not change owner");
    flushSync(() => first.lateEvents(snapshot));
    first.capture.resolve(snapshot); await oldCapture; await tick();
    check(workspace.snapshot === null && workspace.inspectionStage !== "old-port-progress", "old events or result restored the previous session");

    let newCapture!: Promise<UiSnapshot | null>;
    flushSync(() => { newCapture = workspace.inspectDevice("fixture"); });
    second.capture.resolve(snapshot); await newCapture;
    await until(() => workspace.snapshot?.root === node && !workspace.inspectionLoading, "new capture did not settle");
    check(workspace.snapshot?.root === node && !workspace.inspectionLoading, "new port could not capture after replacement");
    let oldRefresh!: Promise<void>;
    flushSync(() => { oldRefresh = workspace.refreshViewNode(node); });
    check(workspace.viewRefreshingNodeId === node.id, "refresh never entered busy state");
    flushSync(() => root.render(<Probe api={third.api} />));
    await until(() => workspace.viewRefreshingNodeId === null && workspace.snapshot === null, "new port retained old refresh state");
    check(second.canceled.length === 1 && second.canceled[0] === second.captureId && third.canceled.length === 0,
      "old refresh was not canceled on its original port exactly once");
    second.refresh.resolve({ nodes: [{ ...node, text: "late refresh" }], failures: [] });
    await oldRefresh; await tick();
    check(workspace.snapshot === null && workspace.viewRefreshStatus === null, "late refresh restored old content or status");
    check(second.activeSubscriptions === 0 && third.activeSubscriptions === 2, "refresh replacement leaked subscriptions");

    const captures: { serial: string; id: string; result: ReturnType<typeof deferred<UiSnapshot>> }[] = [];
    third.api.inspectDevice = (serial, id) => {
      const result = deferred<UiSnapshot>(); captures.push({ serial, id, result }); return result.promise;
    };
    let captureA!: Promise<UiSnapshot | null>, captureB!: Promise<UiSnapshot | null>;
    flushSync(() => { captureA = workspace.inspectDevice("a"); });
    flushSync(() => { captureB = workspace.inspectDevice("b"); });
    check(captures.length === 2 && captures[1].serial === "b" && third.canceled.includes(captures[0].id),
      "same-port device replacement did not cancel the old request");
    captures[0].result.resolve({ ...snapshot, serial: "a" }); await captureA; await tick();
    check(workspace.snapshot === null && workspace.inspectionLoading, "old device result interrupted the replacement capture");
    captures[1].result.resolve({ ...snapshot, serial: "b" }); await captureB;
    await until(() => workspace.snapshot?.serial === "b" && !workspace.inspectionLoading, "replacement device result did not settle");
  } finally {
    flushSync(() => root.unmount()); host.remove();
  }
  check(third.activeSubscriptions === 0, "unmount leaked the final port subscriptions");
  return { checks: ["capture port replacement cancels original request and drops late result/events", "refresh port replacement clears busy state and rejects late refresh", "same-port device replacement cancels and ignores the old capture", "subscriptions move to the new port and release on unmount"] };
}
