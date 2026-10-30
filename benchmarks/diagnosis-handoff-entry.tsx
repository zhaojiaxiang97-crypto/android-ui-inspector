import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import App from "../src/App";
import { diagnosisHandoffFixture } from "./diagnosis-handoff-fixture";
import { verifyDiagnosisHandoff } from "./diagnosis-handoff-verification";
import { verifyWorkbenchLayout, verifyWorkbenchTree, verifyWorkbenchFocus } from "./workbench-layout-checks";
import { verifyWorkbenchCanvas, verifyWorkbenchAppearance } from "./workbench-canvas-checks";
import { propertiesFixture, verifyWorkbenchProperties } from "./workbench-properties-checks";
import { createWorkbenchEntryChecks } from "./workbench-entry-checks";
import { verifyReportImportLifecycle } from "./report-import-checks";

// Source harness only. The candidate harness instead loads the packaged renderer unchanged.
const calls = { captures: 0, writes: 0, deviceActions: 0 };
const canvas = document.createElement("canvas"); canvas.width = 360; canvas.height = 640;
const context = canvas.getContext("2d")!;
context.fillStyle = "#182332"; context.fillRect(0, 0, 360, 640);
context.font = "20px sans-serif"; context.fillStyle = "#ecf1f8";
context.fillText("LOCAL FIXTURE", 24, 108); context.fillText("Playback settings", 24, 178);
const snapshot = diagnosisHandoffFixture(canvas.toDataURL("image/png")), original = JSON.stringify(snapshot);
let activeSnapshot = snapshot, copyFailure = false;
let delayedCopy: Promise<void> | null = null;
const copied: string[] = [];
const forbidden = async (): Promise<never> => { calls.deviceActions++; throw new Error("No device action allowed in local fixture"); };
window.electronApi = {
  runtime: { sandboxed: true, contextIsolated: true, fixtureMode: true, nativeMenu: false, readOnlyDiagnosis: true },
  probeAdb: async () => ({ adbPath: "synthetic-only", adbVersion: "fixture", error: null, devices: [{ serial: snapshot.serial, state: "device", model: "本地样本", androidVersion: "fixture", product: null, transportId: null }] }),
  updateAppMenu: async () => {},
  inspectDevice: async (serial, _id, _priority, single, scope) => {
    calls.captures++;
    if (calls.captures !== 1 || serial !== activeSnapshot.serial || single !== true || scope?.expectedPackage !== "com.example.benchmark")
      throw new Error("Only one scoped synthetic capture allowed");
    return activeSnapshot;
  },
  onInspectionProgress: () => () => {}, onInspectionPreview: () => () => {},
  cancelInspection: forbidden, captureGroup: forbidden, refreshViewNode: forbidden, readViewStyle: forbidden,
  showLayerMenu: forbidden, copyText: async value => {
    if (copyFailure) throw new Error("Synthetic copy failure");
    const delay = delayedCopy; delayedCopy = null;
    if (delay) await delay;
    copied.push(value);
  },
  startDebugSession: forbidden,
  loadSnapshots: async () => ({ snapshots: [], error: null }),
  saveSnapshot: async () => { calls.writes++; throw new Error("No history write allowed"); },
  clearSnapshots: async () => { calls.writes++; throw new Error("No history deletion allowed"); },
  exportSnapshot: async () => { calls.writes++; throw new Error("No export allowed"); },
};
const host = document.createElement("div"); document.body.append(host);
const appRoot = createRoot(host);
const entryChecks = createWorkbenchEntryChecks(appRoot, snapshot);
async function verifyReadOnly<T>(check: () => Promise<T>) {
  const result = await check();
  if (calls.deviceActions || calls.writes || calls.captures !== 1 || JSON.stringify(snapshot) !== original)
    throw new Error("Workbench checks mutated fixture/history or requested another capture/action");
  return result;
}
Object.assign(window, { verifyWorkbenchEntry: entryChecks.verify, showWorkbenchEntryState: entryChecks.showState, showWorkbenchCommands: entryChecks.showCommands });
Object.assign(window, { verifyWorkbenchAppearance: () => verifyReadOnly(() => verifyWorkbenchAppearance(flushSync)) });
Object.assign(window, { verifyReportImportLifecycle: () => verifyReportImportLifecycle(appRoot) });
Object.assign(window, { verifyWorkbenchProperties: async () => {
  activeSnapshot = propertiesFixture(canvas.toDataURL("image/png"));
  const before = JSON.stringify(activeSnapshot);
  calls.captures = calls.writes = calls.deviceActions = 0; copied.length = 0; copyFailure = false;
  flushSync(() => appRoot.render(<App key={crypto.randomUUID()} />));
  const result = await verifyWorkbenchProperties(flushSync, activeSnapshot, copied, value => { copyFailure = value; }, () => {
    let release!: () => void;
    delayedCopy = new Promise<void>(resolve => { release = resolve; });
    return release;
  });
  if (calls.deviceActions || calls.writes || calls.captures !== 1 || JSON.stringify(activeSnapshot) !== before || JSON.stringify(snapshot) !== original)
    throw new Error("Property checks mutated source/history or requested another capture/action");
  return { ...result, calls: { ...calls, sourceUnchanged: true } };
}, verifyWorkbenchCanvas: () => verifyReadOnly(() => verifyWorkbenchCanvas(flushSync, snapshot.root!)),
verifyWorkbenchFocus: () => verifyReadOnly(() => verifyWorkbenchFocus(flushSync)),
verifyWorkbenchLayout: () => verifyWorkbenchLayout(flushSync),
verifyWorkbenchTree: () => verifyReadOnly(() => verifyWorkbenchTree(flushSync)),
verifyDiagnosisHandoff: async () => {
  activeSnapshot = snapshot;
  calls.captures = calls.writes = calls.deviceActions = 0;
  flushSync(() => appRoot.render(<App key={crypto.randomUUID()} />));
  return verifyDiagnosisHandoff(() => ({ ...calls, sourceUnchanged: JSON.stringify(snapshot) === original }), flushSync);
} });
