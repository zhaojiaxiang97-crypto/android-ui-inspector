import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { LivePreviewPanel } from "../src/features/preview/LivePreviewPanel";
import type { LivePreviewApi, LivePreviewEvent, LivePreviewFrame, LivePreviewState } from "../shared/live-preview";
import "../src/styles/tokens.css";
import "../src/App.css";

const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
const wait = async (condition: () => boolean, message: string) => {
  const deadline = performance.now() + 5000;
  while (!condition()) {
    if (performance.now() > deadline) throw Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
function picture(page: string) {
  return `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="360" height="720"><rect width="360" height="720" fill="#f4f5f8"/><rect y="35" width="360" height="80" fill="#dce8f7"/><text x="24" y="85" font-size="24" fill="#234164">${page}</text><rect x="24" y="165" width="312" height="54" rx="6" fill="#fff"/><rect x="24" y="235" width="312" height="54" rx="6" fill="#fff"/><rect x="24" y="330" width="312" height="250" rx="12" fill="#476ca4"/><text x="48" y="385" font-size="20" fill="#fff">Live page</text></svg>`)}`;
}

class PreviewApi implements LivePreviewApi {
  calls: string[] = [];
  listeners = new Set<(event: LivePreviewEvent) => void>();
  pendingStart: ((event: LivePreviewEvent) => void) | null = null;
  deferStart = false;
  failStart = false;
  private revision = 0;
  private sessions = 0;
  private frame: LivePreviewFrame | null = null;
  state: LivePreviewState = { sessionId: null, serial: null, revision: 0, status: "stopped", activity: "idle", intervalMs: 2000,
    startedAt: null, updatedAt: "2026-10-12T01:00:00Z", frameCapturedAt: null, error: null, stopReason: null };
  emit(event: LivePreviewEvent) { for (const listener of this.listeners) listener(event); }
  private update(patch: Partial<LivePreviewState>, frame?: LivePreviewFrame | null) {
    this.state = { ...this.state, ...patch, revision: ++this.revision };
    if (frame !== undefined) this.frame = frame;
    this.emit({ state: { ...this.state }, ...(frame !== undefined ? { frame } : {}) });
    return this.getEvent();
  }
  getEvent(): LivePreviewEvent { return { state: { ...this.state }, frame: this.frame }; }
  async startLivePreview(serial: string) {
    this.calls.push(`start:${serial}`);
    if (this.failStart) throw Error("无法连接设备截图服务");
    const event = this.update({ sessionId: `fixture-${++this.sessions}`, serial, status: "running", activity: "idle",
      startedAt: "2026-10-12T01:00:00Z", frameCapturedAt: null, error: null, stopReason: null }, null);
    if (this.deferStart) {
      this.deferStart = false;
      return new Promise<LivePreviewEvent>(resolve => { this.pendingStart = () => resolve(event); });
    }
    return event;
  }
  async pauseLivePreview(sessionId: string) {
    this.calls.push(`pause:${sessionId}`);
    return this.state.sessionId === sessionId ? this.update({ status: "paused", activity: "idle" }) : this.getEvent();
  }
  async resumeLivePreview(sessionId: string) {
    this.calls.push(`resume:${sessionId}`);
    return this.state.sessionId === sessionId ? this.update({ status: "running", error: null }) : this.getEvent();
  }
  async stopLivePreview(sessionId?: string) {
    this.calls.push(`stop:${sessionId}`);
    return sessionId === undefined || sessionId === this.state.sessionId
      ? this.update({ status: "stopped", activity: "idle", frameCapturedAt: null, stopReason: "closed" }, null) : this.getEvent();
  }
  async getLivePreview() { return this.getEvent(); }
  onLivePreview(callback: (event: LivePreviewEvent) => void) { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; }
  showFrame(page: string) {
    const capturedAt = `2026-10-12T01:00:${String(this.revision % 60).padStart(2, "0")}Z`;
    return this.update({ frameCapturedAt: capturedAt }, { serial: this.state.serial!, sessionId: this.state.sessionId!,
      sequence: this.revision, capturedAt, screenshotDataUrl: picture(page), size: { width: 360, height: 720 } });
  }
  showError() { return this.update({ status: "paused", activity: "idle", error: "截图超时，检查设备后继续。" }); }
}

async function verifyLivePreview() {
  const api = new PreviewApi(), host = document.createElement("div");
  host.className = "app-shell inspection-active";
  document.body.append(host);
  const root = createRoot(host);
  let enabled = false, connected = true, serial = "device-a", treeTime = "2026-10-12T00:58:00Z";
  let selections = 0;
  const checks: string[] = [];
  const draw = () => flushSync(() => root.render(<div className="preview-pane" style={{ position: "relative", width: "100vw", height: "100vh", padding: "28px", boxSizing: "border-box" }}>
    <div style={{ color: "var(--ref-text)", fontSize: "14px", lineHeight: 2 }}>设备画面 · 已采集的控件树</div>
    <div data-selected-node="original-node" style={{ color: "var(--ref-muted)", fontSize: "12px" }}>选中控件：original-node</div>
    <img className="captured-tree-shot" src={picture("Collected tree")} alt="已采集的截图" onClick={() => { selections++; }}
      style={{ display: "block", width: "260px", maxHeight: "75vh", objectFit: "contain", marginTop: "20px" }} />
    <LivePreviewPanel serial={serial} connected={connected} treeCapturedAt={treeTime} enabled={enabled} api={api}
      onClose={() => { enabled = false; draw(); }} />
  </div>));
  const panel = () => host.querySelector<HTMLElement>(".live-preview-panel");
  const previewImage = () => panel()?.querySelector<HTMLImageElement>("img");
  const button = (label: string) => Array.from(panel()?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(candidate => candidate.textContent === label)!;
  const enable = async () => { enabled = true; draw(); await wait(() => Boolean(panel() && !button("重新开启") && button("暂停") && !button("暂停").disabled), "preview start did not settle"); };

  draw(); check(api.calls.length === 0 && !panel(), "a closed panel must not start capture"); checks.push("显式开启");
  await enable(); const first = api.showFrame("Live page A");
  await wait(() => previewImage()?.src === first.frame?.screenshotDataUrl, "first frame was not rendered");
  button("暂停").click(); await wait(() => button("继续")?.disabled === false, "pause did not settle");
  check(previewImage()?.src === first.frame?.screenshotDataUrl, "pause must retain the latest image"); checks.push("暂停保留图");
  treeTime = "2026-10-12T01:03:00Z"; draw();
  check(panel()?.querySelectorAll("time")[1].dateTime === treeTime && previewImage()?.src === first.frame?.screenshotDataUrl,
    "tree refresh must remain independent from paused frames"); checks.push("树时间独立更新");
  api.emit({ ...first, state: { ...first.state, revision: 999, serial: "device-b" } });
  api.emit({ ...first, state: { ...first.state, revision: 999, sessionId: "other-session" } });
  api.emit(first); await new Promise(resolve => setTimeout(resolve, 20));
  check(button("继续") && previewImage()?.src === first.frame?.screenshotDataUrl, "old or unrelated events changed the panel"); checks.push("丢弃迟到事件");
  previewImage()!.click();
  check(selections === 0 && host.querySelector("[data-selected-node]")?.getAttribute("data-selected-node") === "original-node", "preview frames selected a node"); checks.push("帧不能操作控件");
  button("继续").click(); await wait(() => button("暂停")?.disabled === false, "resume did not settle");
  const second = api.showFrame("Live page B"); await wait(() => previewImage()?.src === second.frame?.screenshotDataUrl, "page change not visible"); checks.push("继续和页面变化");
  panel()!.querySelector<HTMLButtonElement>('[aria-label="关闭实时预览"]')!.click();
  await wait(() => !panel() && api.listeners.size === 0 && api.state.status === "stopped", "close did not stop the stream"); checks.push("关闭释放订阅");

  api.deferStart = true; enabled = true; draw();
  await wait(() => api.pendingStart !== null, "pending close start was not requested");
  const closingSession = api.state.sessionId;
  const stopsBeforeClose = api.calls.filter(call => call === "stop:undefined").length;
  enabled = false; draw();
  check(api.calls.filter(call => call === "stop:undefined").length === stopsBeforeClose + 1
    && api.listeners.size === 0 && api.state.status === "stopped", "pending close must cancel immediately, before the start reply");
  api.pendingStart!(api.getEvent()); api.pendingStart = null;
  await wait(() => api.calls.includes(`stop:${closingSession}`), "late closed start did not release its own session");
  check(!panel() && api.state.status === "stopped", "late closed start reopened the panel"); checks.push("开启未完成时关闭立即取消");

  api.deferStart = true; enabled = true; draw();
  await wait(() => api.pendingStart !== null, "delayed start was not requested");
  const oldSession = api.state.sessionId;
  serial = "device-b"; draw(); await wait(() => api.state.serial === "device-b" && button("暂停")?.disabled === false, "switch did not start new device");
  api.pendingStart!(api.getEvent()); api.pendingStart = null;
  await wait(() => api.calls.includes(`stop:${oldSession}`), "late start did not release its own session");
  check(api.state.serial === "device-b" && api.state.status === "running", "late old-device stop killed the new stream"); checks.push("切设备隔离会话");
  const third = api.showFrame("New device"); await wait(() => previewImage()?.src === third.frame?.screenshotDataUrl, "new device frame missing");
  connected = false; draw(); await wait(() => !previewImage() && api.state.status === "stopped", "disconnect left a frame or capture active");
  const starts = api.calls.filter(call => call.startsWith("start:")).length;
  connected = true; draw(); await new Promise(resolve => setTimeout(resolve, 30));
  check(api.calls.filter(call => call.startsWith("start:")).length === starts, "reconnect silently restarted capture"); checks.push("断线停止且不自动重开");
  button("重新开启").click(); await wait(() => button("暂停")?.disabled === false, "explicit restart did not settle");
  api.showFrame("Reopened device"); await wait(() => Boolean(previewImage()), "reopened frame missing"); checks.push("显式重新开启");
  api.showError(); await wait(() => panel()?.querySelector('[role="alert"]')?.textContent?.includes("截图超时") === true, "capture error was not visible"); checks.push("失败暂停并显示原因");
  enabled = false; draw(); await wait(() => api.listeners.size === 0, "cleanup leaked subscribers");
  api.failStart = true; enabled = true; draw();
  await wait(() => panel()?.querySelector('[role="alert"]')?.textContent?.includes("无法连接") === true, "start failure did not display"); checks.push("开启失败提示");
  enabled = false; draw(); api.failStart = false; await enable(); api.showFrame("Visual preview");
  await wait(() => Boolean(previewImage()), "visual frame not ready");
  Object.assign(window, { setLivePreviewVisualState: async (mode: "running" | "paused" | "error") => {
    if (mode === "running") await api.resumeLivePreview(api.state.sessionId!);
    else if (mode === "paused") await api.pauseLivePreview(api.state.sessionId!);
    else api.showError();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  } });
  return { passed: true, checks };
}

Object.assign(window, { verifyLivePreview });
