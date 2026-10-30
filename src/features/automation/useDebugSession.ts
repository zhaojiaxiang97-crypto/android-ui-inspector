import { useCallback, useEffect, useRef, useState } from "react";
import type { DebugSessionState, McpStopSource, UiNode, UiSnapshot } from "../../../shared/types";

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
  const liveSnapshotRef = useRef<UiSnapshot | null>(null);
  const currentSnapshotRef = useRef(snapshot);
  currentSnapshotRef.current = snapshot;
  const stateRef = useRef(debugState);
  const stoppedSessionRef = useRef<string | null>(null);
  const acceptEventsRef = useRef(true);
  const eventRevisionRef = useRef(0);
  const operationRef = useRef(0);

  const stopMcpSharing = useCallback(async (source: McpStopSource = "explicit") => {
    const operation = ++operationRef.current;
    // Reject already-queued snapshots before waiting for the revoke reply.
    stoppedSessionRef.current = stateRef.current?.id ?? null;
    acceptEventsRef.current = false;
    if (stateRef.current) {
      stateRef.current = { ...stateRef.current, active: false, busy: false };
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
      eventRevisionRef.current++;
      if (event.state.active && (!acceptEventsRef.current || event.state.id === stoppedSessionRef.current)) return;
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
    setMcpBusy(true);
    setDebugStatus(null);
    try {
      const state = await window.electronApi.startDebugSession(serial);
      if (operation !== operationRef.current || revision !== eventRevisionRef.current) return;
      if (state && (!state.active || state.id !== stoppedSessionRef.current)) {
        stateRef.current = state;
        setDebugState(state);
        setMcpSharing(false);
      }
    } catch (error) {
      if (operation === operationRef.current) setDebugStatus(error instanceof Error ? error.message : "开启自动调试失败。");
    } finally { if (operation === operationRef.current) setMcpBusy(false); }
  }, [inspectionLoading, mcpBusy]);

  return { mcpSharing, mcpBusy, debugState, debugStatus, setDebugStatus,
    stopMcpSharing, shareMcpSnapshot, copyMcpConfig, startDebugSession };
}
