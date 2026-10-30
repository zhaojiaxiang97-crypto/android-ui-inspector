import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import type { ImportSnapshotFileResult } from "../shared/snapshot-file";
import type { ExportSnapshotResult, UiSnapshot } from "../shared/types";
import { useSnapshotLibrary } from "../src/features/history/useSnapshotLibrary";
import type { SnapshotPort } from "../src/features/history/snapshot-file-service";

const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
function check(value: unknown, message: string): void { if (!value) throw new Error(message); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

export async function verifySnapshotLibrary(root: Root, source: UiSnapshot) {
  const original = JSON.stringify(source), shown: Parameters<Parameters<typeof useSnapshotLibrary>[0]["showSnapshot"]>[] = [];
  let library!: ReturnType<typeof useSnapshotLibrary>, imports = 0, exports = 0, transitions = 0, copiesCleared = 0;
  let importReply = deferred<ImportSnapshotFileResult>(), exportReply = deferred<ExportSnapshotResult>();
  let transition: Promise<void> = Promise.resolve();
  const record = { id: "fixture-record", capturedAt: "2026-10-14T00:00:00Z", savedAt: "2026-10-14T00:00:01Z", snapshot: source };
  const imported: ImportSnapshotFileResult = { canceled: false, filePath: "/fixture/saved.json", data: { snapshot: source, legacy: false, exportedAt: record.capturedAt }, error: null };
  const canceled: ImportSnapshotFileResult = { canceled: true, filePath: null, data: null, error: null };
  const api: SnapshotPort = {
    loadSnapshots: async () => ({ error: null, snapshots: [record] }),
    saveSnapshot: async request => { check(request.snapshot === source && request.capturedAt === record.capturedAt, "History save lost its snapshot or capture timestamp"); return { error: null, snapshots: [record] }; },
    clearSnapshots: async () => ({ error: null, snapshots: [] }),
    importSnapshotFile: async () => { imports++; return importReply.promise; },
    exportSnapshot: async () => { exports++; return exportReply.promise; },
  };
  function Harness() {
    library = useSnapshotLibrary({ api, snapshot: source, treeCapturedAt: record.capturedAt,
      snapshotForStorage: () => source, showSnapshot: (...args) => { shown.push(args); },
      beforeOpen: async () => { transitions++; await transition; }, clearCopyStatus: () => { copiesCleared++; } });
    return null;
  }
  const mount = async () => { flushSync(() => root.render(<Harness />)); await tick(); };
  const startImport = () => { let pending!: Promise<void>; flushSync(() => { pending = library.openSnapshotFile(); }); return pending; };
  try {
    await mount(); check(library.savedSnapshots.length === 1 && !library.snapshotsLoading, "History restore failed");
    const first = startImport(); await library.openSnapshotFile();
    await library.exportCurrentSnapshot("snapshot");
    check(imports === 1 && exports === 0 && library.openingSnapshot, "Pending import allowed duplicate dialog or full export");
    flushSync(() => library.invalidateSnapshotFile()); // A different device/current capture now owns the workspace.
    importReply.resolve(imported); await first; await tick();
    check(!shown.length && !library.openingSnapshot && !library.snapshotFileStatus && transitions === 0, "Invalidated file replaced the active device");

    importReply = deferred(); const cancel = startImport(); importReply.resolve(canceled); await cancel; await tick();
    check(!library.snapshotFileStatus && !library.openingSnapshot && !shown.length, "Cancel left an error or replaced the snapshot");

    importReply = deferred(); const stop = deferred<void>(); transition = stop.promise;
    const duringStop = startImport(); importReply.resolve(imported); await tick();
    check(transitions === 1 && library.openingSnapshot, "Import failed to await the workspace handoff");
    flushSync(() => library.resetForHome()); stop.resolve(); await duringStop; await tick();
    check(!shown.length && !library.snapshotOrigin, "Late handoff reopened a closed workspace");

    transition = Promise.resolve(); importReply = deferred(); const success = startImport(); importReply.resolve(imported); await success; await tick();
    check(shown.length === 1 && shown[0][0] === source && library.snapshotOrigin?.label.includes("saved.json"), "Offline snapshot was not opened");
    const firstExport = library.exportCurrentSnapshot("snapshot"); await library.exportCurrentSnapshot("snapshot");
    check(exports === 1, `Duplicate complete export gate failed (${exports}, ${library.exportStatus})`);
    exportReply.resolve({ canceled: true, filePath: null, error: null }); await firstExport; await tick();
    check(!library.exportStatus && !library.snapshotFileStatus, "Canceled export reported success or error");
    exportReply = deferred(); const nextExport = library.exportCurrentSnapshot("snapshot");
    exportReply.resolve({ canceled: false, filePath: "/fixture/export.json", error: null }); await nextExport; await tick();
    check(exports === 2 && library.exportStatus?.includes("export.json"), "Canceled export did not release its pending gate");

    await library.saveCurrentSnapshot(); await tick();
    flushSync(() => library.viewSavedSnapshot(library.savedSnapshots[0]));
    check(shown.at(-1)?.[2] === record.capturedAt && library.snapshotOrigin?.label === "历史快照", "History view lost capture timestamp/origin");
    flushSync(() => library.showLiveSnapshot(source, source.root!.id));
    check(shown.at(-1)?.[1] === source.root!.id && !library.snapshotOrigin, "Live handoff lost selected node or kept offline origin");
    await library.clearSavedSnapshots(); await tick(); check(!library.savedSnapshots.length && !library.latestDiff, "Cleared history retained records/diff");

    importReply = deferred(); const afterUnmount = startImport(), shownBefore = shown.length;
    flushSync(() => root.render(null)); importReply.resolve(imported); await afterUnmount;
    check(shown.length === shownBefore && JSON.stringify(source) === original && copiesCleared > 0, "Unmounted import changed the workspace/source");
    return { importInvalidation: true, cancel: true, handoffRace: true, unmount: true, exportReentry: true, historyTimestamps: true, liveSelection: true, sourceUnchanged: true };
  } finally { flushSync(() => root.render(null)); }
}
