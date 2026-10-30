import { verifyDiagnosisHandoff, type HandoffAudit } from "./diagnosis-handoff-verification";
import type { UiSnapshot } from "../shared/types";
import { verifyWorkbenchLayout, verifyWorkbenchTree, verifyWorkbenchFocus } from "./workbench-layout-checks";
import { verifyWorkbenchCanvas } from "./workbench-canvas-checks";
import { verifyWorkbenchProperties } from "./workbench-properties-checks";
import { verifyHomeState, verifyEntryControls, verifyOfflineHistory, verifyEmptyCapture, verifyFailedCapture } from "./workbench-entry-verification";

// Injects only assertions. App, React and styles must come from the candidate's own HTML.
const fixtureWindow = window as unknown as Window & {
  diagnosisFixtureAudit: () => Promise<HandoffAudit>;
  diagnosisFixtureControl: (method: string, ...args: unknown[]) => unknown;
};
const control = <T>(method: string, ...args: unknown[]) => fixtureWindow.diagnosisFixtureControl(method, ...args) as T;
const act = (action: () => void) => action();
Object.assign(window, {
  verifyDiagnosisHandoff: () => verifyDiagnosisHandoff(() => fixtureWindow.diagnosisFixtureAudit()),
  verifyWorkbenchLayout: () => verifyWorkbenchLayout(act),
  verifyWorkbenchTree: () => verifyWorkbenchTree(act),
  verifyWorkbenchFocus: () => verifyWorkbenchFocus(act),
  verifyWorkbenchCanvas: () => verifyWorkbenchCanvas(act, control<UiSnapshot>("snapshot").root!),
  verifyWorkbenchProperties: () => verifyWorkbenchProperties(act, control<UiSnapshot>("snapshot"),
    () => control<string[]>("copied"), value => control("failCopy", value), () => {
      control("holdCopy"); return () => { control("releaseCopy"); };
    }),
  verifyHomeState: (state: string) => verifyHomeState(state, true),
  verifyEntryControls, verifyOfflineHistory, verifyEmptyCapture, verifyFailedCapture,
});
