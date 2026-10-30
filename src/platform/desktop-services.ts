import type { DesktopApi } from "../../shared/desktop-api";

export type SnapshotPort = Pick<DesktopApi,
  "exportSnapshot" | "importSnapshotFile" | "loadSnapshots" | "saveSnapshot" | "clearSnapshots">;
export type MenuPort = Pick<DesktopApi, "runtime" | "updateAppMenu" | "onAppMenuAction" | "setWindowMode">;
export type InspectionPort = Pick<DesktopApi,
  "inspectDevice" | "cancelInspection" | "captureGroup" | "refreshViewNode" | "captureLayerImages" | "cancelLayerImages" |
  "showLayerMenu" | "onInspectionProgress" | "onInspectionPreview">;
export type DiagnosisPort = Required<Pick<DesktopApi, "diagnoseConnection" | "cancelConnectionDiagnosis">>;
export type InspectionModePort = Required<Pick<DesktopApi, "getInspectionMode" | "setInspectionMode" | "onInspectionMode">>;

/** Resolve capabilities at composition time, never during module import. */
export function createDesktopServices(api: DesktopApi): {
  snapshots: SnapshotPort; menu: MenuPort; inspection: InspectionPort; diagnostics: DiagnosisPort | undefined;
  inspectionMode: InspectionModePort | undefined;
} {
  return {
    snapshots: api,
    menu: api,
    inspection: api,
    inspectionMode: !api.runtime.fixtureMode && api.getInspectionMode && api.setInspectionMode && api.onInspectionMode
      ? { getInspectionMode: api.getInspectionMode, setInspectionMode: api.setInspectionMode, onInspectionMode: api.onInspectionMode }
      : undefined,
    diagnostics: api.diagnoseConnection && api.cancelConnectionDiagnosis
      ? { diagnoseConnection: api.diagnoseConnection, cancelConnectionDiagnosis: api.cancelConnectionDiagnosis }
      : undefined,
  };
}
