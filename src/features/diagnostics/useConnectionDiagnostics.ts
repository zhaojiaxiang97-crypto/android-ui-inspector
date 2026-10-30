import type { DiagnosisPort } from "../../platform/desktop-services";
import { useCallback, useEffect, useRef, useState } from "react";
import { connectionDiagnosticKey, connectionDiagnosticRequest, matchesConnectionDiagnostic,
  type ConnectionDiagnosticTarget, type ConnectionDiagnosticRequest, type ConnectionDiagnosticReport } from "../../../shared/connection-diagnostics";

export type ConnectionDiagnosticApi = DiagnosisPort;

export function useConnectionDiagnostics(target: ConnectionDiagnosticTarget | null, api: ConnectionDiagnosticApi | undefined) {
  const key = target ? connectionDiagnosticKey(target) : null;
  const currentKey = useRef(key); currentKey.current = key;
  const apiRef = useRef(api); apiRef.current = api;
  const active = useRef<{ requestId: string; key: string } | null>(null);
  const [state, setState] = useState<{ key: string | null; running: boolean; report: ConnectionDiagnosticReport | null; message: string | null }>(
    { key: null, running: false, report: null, message: null });
  const cancel = useCallback(() => {
    const request = active.current; active.current = null;
    if (request) {
      void apiRef.current?.cancelConnectionDiagnosis(request.requestId).catch(() => undefined);
      setState({ key: currentKey.current, running: false, report: null, message: "本次诊断已取消。" });
    }
  }, []);
  useEffect(() => {
    setState({ key, running: false, report: null, message: null });
    return () => {
      const request = active.current; active.current = null;
      if (request) void apiRef.current?.cancelConnectionDiagnosis(request.requestId).catch(() => undefined);
    };
  }, [key]);
  const run = useCallback(async () => {
    if (!target || !key || !apiRef.current || active.current) return;
    let request: ConnectionDiagnosticRequest;
    try { request = connectionDiagnosticRequest.parse({ ...target, requestId: crypto.randomUUID(), client: "desktop" }); }
    catch { setState({ key, running: false, report: null, message: "设备或 App 包名无效，请检查后再诊断。" }); return; }
    const pending = { requestId: request.requestId, key }; active.current = pending;
    setState({ key, running: true, report: null, message: null });
    try {
      const report = await apiRef.current.diagnoseConnection(request);
      if (active.current !== pending || currentKey.current !== key) return;
      if (!matchesConnectionDiagnostic(report, request)) throw new Error("诊断结果身份不符，请重新诊断。");
      setState({ key, running: false, report, message: null });
    } catch (error) {
      if (active.current === pending && currentKey.current === key)
        setState({ key, running: false, report: null, message: error instanceof Error ? error.message : "诊断失败，请重新检查连接。" });
    } finally { if (active.current === pending) active.current = null; }
  }, [target, key]);
  return { running: state.key === key && state.running, report: state.key === key ? state.report : null,
    message: state.key === key ? state.message : null, run, cancel, available: Boolean(api && target) };
}
