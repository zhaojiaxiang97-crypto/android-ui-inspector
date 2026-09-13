import type { AdbProbeResult, ExportSnapshotRequest, ExportSnapshotResult, SaveSnapshotRequest, SnapshotStoreResult, UiSnapshot } from "../shared/types";

declare global {
  interface Window {
    electronApi: {
      readonly runtime: { readonly sandboxed: boolean; readonly contextIsolated: boolean; readonly fixtureMode?: boolean };
      probeAdb: () => Promise<AdbProbeResult>;
      inspectDevice: (serial: string) => Promise<UiSnapshot>;
      copyText: (value: string) => Promise<void>;
      exportSnapshot: (request: ExportSnapshotRequest) => Promise<ExportSnapshotResult>;
      loadSnapshots: () => Promise<SnapshotStoreResult>;
      saveSnapshot: (request: SaveSnapshotRequest) => Promise<SnapshotStoreResult>;
      clearSnapshots: () => Promise<SnapshotStoreResult>;
    };
  }
}

export {};
