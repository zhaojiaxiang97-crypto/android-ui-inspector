import { useCallback, useEffect, useRef, useState } from "react";
import type { ExportFormat, UiSnapshot } from "../../../shared/types";
import { addSnapshotDiffs, type SavedSnapshot, type SnapshotDiff } from "./model";
import { snapshotExportRequest } from "./snapshot-file-service";
import type { SnapshotPort } from "../../platform/desktop-services";

type Options = {
  api: SnapshotPort;
  snapshot: UiSnapshot | null;
  treeCapturedAt: string | null;
  snapshotForStorage: () => UiSnapshot | null;
  showSnapshot: (snapshot: UiSnapshot, selectedNodeId?: string | null, capturedAt?: string) => void;
  beforeOpen: () => Promise<void>;
  clearCopyStatus: () => void;
};

// Own the local library and file-operation lifetime; inspection owns active device sessions.
export function useSnapshotLibrary({ api, snapshot, treeCapturedAt, snapshotForStorage, showSnapshot, beforeOpen, clearCopyStatus }: Options) {
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [savedSnapshots, setSavedSnapshots] = useState<SavedSnapshot[]>([]);
  const [snapshotFileBytes, setSnapshotFileBytes] = useState<number | null>(null);
  const [snapshotsLoading, setSnapshotsLoading] = useState(true);
  const [snapshotStoreError, setSnapshotStoreError] = useState<string | null>(null);
  const [snapshotStatus, setSnapshotStatus] = useState<string | null>(null);
  const [snapshotOrigin, setSnapshotOrigin] = useState<{ snapshot: UiSnapshot; id?: string; label: string } | null>(null);
  const [diffExportStatus, setDiffExportStatus] = useState<string | null>(null);
  const [latestDiff, setLatestDiff] = useState<SnapshotDiff | null>(null);
  const [diffExpanded, setDiffExpanded] = useState(false);
  const [openingSnapshot, setOpeningSnapshot] = useState(false);
  const [snapshotFileStatus, setSnapshotFileStatus] = useState<{ message: string; error?: boolean } | null>(null);
  const snapshotFileRequest = useRef(0);
  const snapshotFilePending = useRef(false);
  const fullExportPending = useRef(false);
  const snapshotFileMounted = useRef(true);
  useEffect(() => {
    snapshotFileMounted.current = true;
    return () => { snapshotFileMounted.current = false; snapshotFileRequest.current++; };
  }, []);
  const invalidateSnapshotFile = useCallback(() => {
    snapshotFileRequest.current++;
    setSnapshotFileStatus(null);
  }, []);
  const showLiveSnapshot = useCallback((next: UiSnapshot, selectedNodeId?: string | null) => {
    invalidateSnapshotFile();
    setSnapshotOrigin(null);
    showSnapshot(next, selectedNodeId, new Date().toISOString());
    setLatestDiff(null);
    setSnapshotStatus(null);
    clearCopyStatus();
    setExportStatus(null);
  }, [showSnapshot, invalidateSnapshotFile, clearCopyStatus]);
  useEffect(() => {
    let active = true;
    async function restoreSnapshots() {
      setSnapshotsLoading(true);
      try {
        const result = await api.loadSnapshots();
        if (!active) return;
        setSnapshotStoreError(result.error);
        setSavedSnapshots(result.error ? [] : addSnapshotDiffs(result.snapshots));
        if (!result.error) setSnapshotFileBytes(result.fileBytes ?? null);
      } catch {
        if (active) {
          setSnapshotStoreError("读取本地快照失败");
          setSavedSnapshots([]);
        }
      } finally {
        if (active) setSnapshotsLoading(false);
      }
    }

    void restoreSnapshots();
    return () => {
      active = false;
    };
  }, [api]);

  const exportCurrentSnapshot = useCallback(async (format: ExportFormat) => {
    if (!snapshot || format === "snapshot" && (fullExportPending.current || snapshotFilePending.current)) return;
    const request = format === "snapshot" ? ++snapshotFileRequest.current : null;
    if (request !== null) fullExportPending.current = true;
    const status = (message: string | null, error = false) => {
      setExportStatus(message);
      if (request !== null && request === snapshotFileRequest.current) setSnapshotFileStatus(message ? { message, error } : null);
    };
    status("正在准备导出…");
    try {
      const output = snapshotExportRequest(snapshot, format, format === "snapshot" ? snapshotForStorage() : null);
      if (!output) { status(`当前没有可导出的 ${format.toUpperCase()} 内容`, true); return; }
      const result = await api.exportSnapshot(output);
      if (result.canceled) {
        status(null);
      } else if (result.error) {
        status(result.error, true);
      } else {
        status(`已保存：${result.filePath}`);
      }
    } catch (error) {
      status(error instanceof Error ? error.message : "导出失败，请重试", true);
    } finally { if (request !== null) fullExportPending.current = false; }
  }, [snapshot, snapshotForStorage, api]);

  const exportLatestDiff = useCallback(async () => {
    if (!latestDiff || !snapshot) return;

    setDiffExportStatus("正在准备差异导出…");
    try {
      const stamp = new Date().toISOString().replace(/[.:]/g, "-");
      const result = await api.exportSnapshot({
        format: "json",
        data: JSON.stringify({
          exportedAt: new Date().toISOString(),
          serial: snapshot.serial,
          currentNodeCount: snapshot.nodeCount,
          diff: latestDiff,
        }, null, 2),
        defaultFileName: `android-ui-inspector-diff-${stamp}.json`,
      });
      if (result.canceled) {
        setDiffExportStatus(null);
      } else if (result.error) {
        setDiffExportStatus(result.error);
      } else {
        setDiffExportStatus(`差异已保存：${result.filePath}`);
      }
    } catch {
      setDiffExportStatus("差异导出失败，请重试");
    }
  }, [latestDiff, snapshot, api]);

  const saveCurrentSnapshot = useCallback(async () => {
    if (!snapshot?.root) {
      setSnapshotStatus("当前没有可保存的 UI 快照");
      return;
    }

    setSnapshotStatus("正在保存本地快照…");
    try {
      const result = await api.saveSnapshot({
        capturedAt: treeCapturedAt ?? new Date().toISOString(),
        snapshot: snapshotForStorage() ?? snapshot,
      });
      if (result.error) {
        setSnapshotStoreError(result.error);
        setSnapshotStatus(result.error);
        return;
      }

      const records = addSnapshotDiffs(result.snapshots);
      const newest = records[records.length - 1];
      setSavedSnapshots(records);
      setSnapshotFileBytes(result.fileBytes ?? null);
      setSnapshotStoreError(null);
      setLatestDiff(newest?.diff ?? null);
      setDiffExpanded(false);
      setSnapshotStatus(newest ? `已保存本地快照 ${newest.id.slice(0, 8)}` : "已保存本地快照");
    } catch {
      setSnapshotStoreError("保存本地快照失败");
      setSnapshotStatus("保存本地快照失败");
    }
  }, [snapshot, snapshotForStorage, treeCapturedAt, api]);

  const exportSavedSnapshot = useCallback(async (entry: SavedSnapshot) => {
    setSnapshotStatus("正在导出历史快照…");
    try {
      const request = snapshotExportRequest(entry.snapshot, "snapshot", entry.snapshot);
      if (!request) throw new Error("这份历史记录没有可导出的完整快照。");
      request.defaultFileName = "android-ui-inspector-history-" + entry.id.slice(0, 8) + ".json";
      const result = await api.exportSnapshot(request);
      if (result.canceled) setSnapshotStatus("已取消导出；历史记录未更改。");
      else if (result.error) setSnapshotStatus("历史导出失败：" + result.error + "；记录未更改。");
      else setSnapshotStatus("已导出：" + result.filePath + "；确认文件可重新打开后再删除历史记录。");
    } catch (error) {
      setSnapshotStatus("历史导出失败：" + (error instanceof Error ? error.message : "未知错误") + "；记录未更改。");
    }
  }, [api]);

  const clearSavedSnapshots = useCallback(async () => {
    if (!window.confirm("确定清空全部本地快照吗？删除后不可恢复，请先导出需要保留的记录。")) return;
    setSnapshotStatus("正在清空本地快照…");
    try {
      const result = await api.clearSnapshots();
      if (result.error) {
        setSnapshotStoreError(result.error);
        setSnapshotStatus(result.error);
        return;
      }
      setSavedSnapshots([]);
      setSnapshotFileBytes(result.fileBytes ?? 2);
      setSnapshotStoreError(null);
      setLatestDiff(null);
      setDiffExpanded(false);
      setSnapshotStatus("已清空本地快照");
    } catch {
      setSnapshotStoreError("清空本地快照失败");
      setSnapshotStatus("清空本地快照失败");
    }
  }, [api]);

  const deleteSavedSnapshot = useCallback(async (id: string) => {
    if (!api.deleteSnapshot || !window.confirm("确定从本地历史库中删除这份快照吗？")) return;
    setSnapshotStatus("正在删除本地快照…");
    try {
      const result = await api.deleteSnapshot(id);
      if (result.error) {
        setSnapshotStoreError(result.error);
        setSnapshotStatus(result.error);
        return;
      }
      const records = addSnapshotDiffs(result.snapshots);
      setSavedSnapshots(records);
      setSnapshotFileBytes(result.fileBytes ?? null);
      setSnapshotStoreError(null);
      setLatestDiff(records.at(-1)?.diff ?? null);
      setDiffExpanded(false);
      if (snapshotOrigin?.id === id) setSnapshotOrigin(null);
      setSnapshotStatus("已删除本地记录；正在显示的画面需要切换页面才能从内存中移除。");
    } catch {
      setSnapshotStoreError("删除本地快照失败");
      setSnapshotStatus("删除本地快照失败");
    }
  }, [api, snapshotOrigin]);

  const viewSavedSnapshot = useCallback((entry: SavedSnapshot) => {
    invalidateSnapshotFile();
    void beforeOpen();
    showSnapshot(entry.snapshot, null, entry.capturedAt);
    setSnapshotOrigin({ snapshot: entry.snapshot, id: entry.id, label: "历史快照" });
    clearCopyStatus();
    setExportStatus(null);
    setDiffExportStatus(null);
    setLatestDiff(entry.diff);
    setDiffExpanded(false);
    setSnapshotStatus(`正在查看历史快照 ${entry.id.slice(0, 8)}`);
  }, [beforeOpen, showSnapshot, invalidateSnapshotFile, clearCopyStatus]);

  const openSnapshotFile = useCallback(async () => {
    if (snapshotFilePending.current || !api.importSnapshotFile) return;
    snapshotFilePending.current = true;
    const request = ++snapshotFileRequest.current;
    setOpeningSnapshot(true);
    setSnapshotFileStatus({ message: "正在打开快照…请完成文件选择；如有系统权限提示，请先确认。" });
    try {
      const result = await api.importSnapshotFile();
      if (request !== snapshotFileRequest.current) return;
      if (result.canceled) { setSnapshotFileStatus(null); return; }
      if (result.error || !result.data) throw new Error(result.error || "快照文件没有可查看的内容。");
      await beforeOpen();
      if (request !== snapshotFileRequest.current) return;
      showSnapshot(result.data.snapshot);
      setLatestDiff(null); setDiffExpanded(false); clearCopyStatus(); setExportStatus(null); setDiffExportStatus(null);
      const name = result.filePath?.split(/[\\/]/).pop() || "快照文件";
      setSnapshotOrigin({ snapshot: result.data.snapshot, label: `离线快照 · ${name}` });
      const message = result.data.legacy ? `已打开旧版控件树 · ${name}；文件未保存整屏截图。` : `正在查看离线快照 · ${name}`;
      setSnapshotStatus(message);
      setSnapshotFileStatus({ message });
    } catch (error) {
      if (request === snapshotFileRequest.current) setSnapshotFileStatus({ message: error instanceof Error ? error.message : "快照文件无法打开。", error: true });
    } finally {
      snapshotFilePending.current = false;
      if (snapshotFileMounted.current) setOpeningSnapshot(false);
    }
  }, [showSnapshot, beforeOpen, api, clearCopyStatus]);

  const resetForCapture = useCallback(() => {
    invalidateSnapshotFile(); setExportStatus(null); setSnapshotStatus(null); setLatestDiff(null); setDiffExpanded(false);
  }, [invalidateSnapshotFile]);
  const resetForHome = useCallback(() => { resetForCapture(); setSnapshotOrigin(null); }, [resetForCapture]);
  const dismissSnapshotFileStatus = useCallback(() => setSnapshotFileStatus(null), []);
  return { savedSnapshots, snapshotFileBytes, snapshotsLoading, snapshotStoreError, snapshotStatus, snapshotOrigin, diffExportStatus,
    latestDiff, diffExpanded, setDiffExpanded, exportStatus, openingSnapshot, snapshotFileStatus, dismissSnapshotFileStatus,
    invalidateSnapshotFile, resetForCapture, resetForHome, showLiveSnapshot,
    exportCurrentSnapshot, exportLatestDiff, exportSavedSnapshot, saveCurrentSnapshot, clearSavedSnapshots, deleteSavedSnapshot, viewSavedSnapshot, openSnapshotFile };
}
