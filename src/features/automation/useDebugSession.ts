import { useCallback, useEffect, useRef, useState } from "react";
import { mcpStopReasons, type DebugSessionStartOptions, type DebugSessionState, type McpStopSource, type UiNode, type UiSnapshot } from "../../../shared/types";
import { acceptDebugSessionUpdate } from "../../../shared/debug-progress";

type Workspace = {
  snapshot: UiSnapshot | null;
  selectedNode: UiNode | null;
  inspectionLoading: boolean;
  showSnapshot: (snapshot: UiSnapshot, selectedNodeId?: string | null) => void;
};

// The main process remains the authority for grants; this hook only mirrors them.
export function useDebugSession({ snapshot, selectedNode, inspectionLoading, showSnapshot }: Workspace) {
  const [mcpSharing, setMcpSharing] = useState(false);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [debugState, setDebugState] = useState<DebugSessionState | null>(null);
  const [debugStatus, setDebugStatus] = useState<string | null>(null);
  const [androidLogsEnabled, setAndroidLogsEnabled] = useState(false);
  const liveSnapshotRef = useRef<UiSnapshot | null>(null);
  const lastSnapshotRef = useRef(snapshot);
  const currentSnapshotRef = useRef(snapshot);
  currentSnapshotRef.current = snapshot;
  const stateRef = useRef(debugState);
  const stoppedSessionRef = useRef<string | null>(null);
  const acceptEventsRef = useRef(true);
  const eventRevisionRef = useRef(0);
  const operationRef = useRef(0);
  const retiredSessionsRef = useRef(new Set<string>());
  const startingSessionRef = useRef(false);

  const stopMcpSharing = useCallback(async (source: McpStopSource = "explicit") => {
    const operation = ++operationRef.current;
    // Reject already-queued snapshots before waiting for the revoke reply.
    stoppedSessionRef.current = stateRef.current?.id ?? null;
    acceptEventsRef.current = false;
    startingSessionRef.current = false;
    if (stateRef.current) {
      const previous = stateRef.current;
      stateRef.current = { ...previous, active: false, busy: false, stopReason: mcpStopReasons[source],
        ...(previous.progress ? { progress: { ...previous.progress, phase: "cancelled", finishedAt: new Date().toISOString(),
          stepFinishedAt: previous.progress.stepFinishedAt ?? new Date().toISOString(), reason: mcpStopReasons[source] } } : {}) };
      setDebugState(stateRef.current);
    }
    setMcpSharing(false);
    setMcpBusy(false);
    try {
      await window.electronApi.stopMcpSharing?.(source);
      if (operation === operationRef.current) setDebugStatus(null);
    } catch {
      if (operation === operationRef.current) setDebugStatus("停止 MCP 共享失败，请关闭程序后重试。");
    }
  }, []);

  useEffect(() => {
    // Initial mounting is not a user snapshot switch. This also lets an
    // explicitly configured local development session start after page load.
    if (lastSnapshotRef.current === snapshot) return;
    lastSnapshotRef.current = snapshot;
    if (snapshot && snapshot === liveSnapshotRef.current) return;
    void stopMcpSharing("snapshot-change");
  }, [snapshot, stopMcpSharing]);

  useEffect(() => {
    let active = true;
    const revision = eventRevisionRef.current;
    const operation = operationRef.current;
    // Subscribe before reading: a reply issued earlier must not erase a newer event.
    const off = window.electronApi.onDebugSession?.(event => {
      if (!active) return;
      if (event.state.active && (!acceptEventsRef.current || event.state.id === stoppedSessionRef.current)) return;
      if (!acceptDebugSessionUpdate(stateRef.current, event.state, retiredSessionsRef.current, startingSessionRef.current)) return;
      eventRevisionRef.current++;
      if (stateRef.current && stateRef.current.id !== event.state.id) retiredSessionsRef.current.add(stateRef.current.id);
      stateRef.current = event.state;
      setDebugState(event.state);
      if (!event.state.active || !event.snapshot || event.snapshot.serial !== event.state.serial) return;
      liveSnapshotRef.current = event.snapshot;
      setMcpSharing(false);
      showSnapshot(event.snapshot, event.selectedNodeId);
    });
    void window.electronApi.getDebugSession?.().then(state => {
      if (!active || revision !== eventRevisionRef.current || operation !== operationRef.current) return;
      if (state?.active && (!acceptEventsRef.current || state.id === stoppedSessionRef.current)) return;
      if (!acceptDebugSessionUpdate(stateRef.current, state, retiredSessionsRef.current)) return;
      stateRef.current = state;
      setDebugState(state);
    }).catch(() => {
      if (active && revision === eventRevisionRef.current && operation === operationRef.current)
        setDebugStatus("读取自动调试状态失败，请重新打开程序。");
    });
    return () => { active = false; operationRef.current++; off?.(); };
  }, [showSnapshot]);

  const shareMcpSnapshot = useCallback(async () => {
    if (!snapshot?.root || mcpBusy || !window.electronApi.shareMcpSnapshot) return;
    const operation = ++operationRef.current;
    setMcpBusy(true);
    try {
      const result = await window.electronApi.shareMcpSnapshot(snapshot, selectedNode?.id ?? null);
      if (operation !== operationRef.current || currentSnapshotRef.current !== snapshot) return;
      if (result.shared) { setMcpSharing(true); setDebugStatus("MCP 已共享这一份快照；切换或重新采集会停止共享。"); }
      else if (result.error) setDebugStatus(result.error);
    } catch {
      if (operation === operationRef.current && currentSnapshotRef.current === snapshot) setDebugStatus("MCP 共享失败。");
    } finally { if (operation === operationRef.current) setMcpBusy(false); }
  }, [snapshot, selectedNode, mcpBusy]);

  const copyMcpConfig = useCallback(async () => {
    try { await window.electronApi.copyMcpConfig?.(); setDebugStatus("MCP 配置已复制；客户端需要 Node.js 22+。"); }
    catch { setDebugStatus("复制 MCP 配置失败。"); }
  }, []);

  const startDebugSession = useCallback(async (serial: string) => {
    if (mcpBusy || inspectionLoading || !window.electronApi.startDebugSession) return;
    const operation = ++operationRef.current;
    const revision = eventRevisionRef.current;
    acceptEventsRef.current = true;
    startingSessionRef.current = true;
    setMcpBusy(true);
    setDebugStatus(null);
    try {
      const start = window.electronApi.startDebugSession as (serial: string, options?: DebugSessionStartOptions) => Promise<DebugSessionState | null>;
      const state = await start(serial, { androidLogs: androidLogsEnabled });
      if (operation !== operationRef.current || revision !== eventRevisionRef.current) return;
      if (state && (!state.active || state.id !== stoppedSessionRef.current)) {
        if (!acceptDebugSessionUpdate(stateRef.current, state, retiredSessionsRef.current, true)) return;
        if (stateRef.current && stateRef.current.id !== state.id) retiredSessionsRef.current.add(stateRef.current.id);
        stateRef.current = state;
        setDebugState(state);
        setMcpSharing(false);
      }
    } catch (error) {
      if (operation === operationRef.current) setDebugStatus(error instanceof Error ? error.message : "开启自动调试失败。");
    } finally { if (operation === operationRef.current) { startingSessionRef.current = false; setMcpBusy(false); } }
  }, [inspectionLoading, mcpBusy, androidLogsEnabled]);

  return { mcpSharing, mcpBusy, debugState, debugStatus, setDebugStatus,
    stopMcpSharing, shareMcpSnapshot, copyMcpConfig, startDebugSession, androidLogsEnabled, setAndroidLogsEnabled };
}
