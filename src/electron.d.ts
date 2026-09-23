import type { AdbProbeResult, ExportSnapshotRequest, ExportSnapshotResult, InspectionProgress, SaveSnapshotRequest, SnapshotStoreResult, UiSnapshot } from "../shared/types";

declare global {
  interface Window {
    electronApi: {
      readonly runtime: { readonly sandboxed: boolean; readonly contextIsolated: boolean; readonly fixtureMode?: boolean };
      probeAdb: () => Promise<AdbProbeResult>;
      inspectDevice: (serial: string, requestId: string) => Promise<UiSnapshot>;
      cancelInspection: (requestId: string) => Promise<void>;
      showLayerMenu: (canHide: boolean, canRestore: boolean) => Promise<"hide" | "restore" | null>;
      onInspectionProgress: (callback: (progress: InspectionProgress) => void) => () => void;
      copyText: (value: string) => Promise<void>;
      exportSnapshot: (request: ExportSnapshotRequest) => Promise<ExportSnapshotResult>;
      loadSnapshots: () => Promise<SnapshotStoreResult>;
      saveSnapshot: (request: SaveSnapshotRequest) => Promise<SnapshotStoreResult>;
      clearSnapshots: () => Promise<SnapshotStoreResult>;
    };
  }
}

export {};
