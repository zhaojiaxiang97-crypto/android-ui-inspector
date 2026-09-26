import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { debugCommand, matchesDebugSelector, type DebugCommand } from "../shared/debug-protocol";
import { assessCaptureGeometry, clipBounds } from "../shared/screen-coordinates";
import { flattenNodes, nodeDisplayLabel } from "../shared/tree-utils";
import type { DebugSessionEvent, DebugSessionState, DebugStep, UiNode } from "../shared/types";
import { observeDebugApp, inputDebugApp, type DebugInputAction, type DebugTarget } from "./adb";
import { publishMcpSnapshot, revokeMcpSnapshot, writePrivateJson, type McpSnapshot } from "./mcp-snapshot";

type Observation = Awaited<ReturnType<typeof observeDebugApp>>;
type Current = { entry: McpSnapshot; target: DebugTarget };
const message = (error: unknown) => error instanceof Error ? error.message : "操作失败。";

export function sameControl(a: UiNode, b: UiNode) {
  return ["package", "className", "resourceId", "text", "contentDesc"].every(key => a[key as keyof UiNode] === b[key as keyof UiNode])
    && a.bounds && b.bounds && ["left", "top", "right", "bottom"].every(key => a.bounds![key as keyof typeof a.bounds] === b.bounds![key as keyof typeof b.bounds]);
}

function resolveControl(previous: UiNode, snapshot: Observation["snapshot"], packageName: string, capability: "clickable" | "scrollable") {
  if (!previous.resourceId && !previous.text && !previous.contentDesc) throw new Error("控件缺少稳定名称或 ID，无法安全自动操作。");
  const nodes = [...flattenNodes(snapshot.root!).values()];
  const matches = nodes.filter(node => sameControl(previous, node) && node.package === packageName && node.visibleToUser);
  if (matches.length !== 1) throw new Error("控件已移动、改变或匹配不唯一，请重新观察和定位。");
  const target = matches[0];
  if (!target[capability] || !target.enabled || !target.bounds) throw new Error(capability === "clickable"
    ? "控件不可点击或未启用，请定位实际可点击的父控件。" : "控件不可滚动或未启用，请定位实际可滚动的容器。");
  const size = snapshot.captureGeometry?.screenshotSize;
  const bounds = size && clipBounds(target.bounds, size);
  if (!bounds) throw new Error("控件不在屏幕内。");
  return { target, nodes, bounds };
}

const related = (a: UiNode, b: UiNode) => a.id === b.id || a.id.startsWith(`${b.id}/`) || b.id.startsWith(`${a.id}/`);

export function resolveTap(previous: UiNode, snapshot: Observation["snapshot"], packageName: string) {
  const { target, nodes, bounds } = resolveControl(previous, snapshot, packageName, "clickable");
  const x = Math.floor((bounds.left + bounds.right) / 2), y = Math.floor((bounds.top + bounds.bottom) / 2);
  const covers = (node: UiNode) => node.bounds && x >= node.bounds.left && x < node.bounds.right && y >= node.bounds.top && y < node.bounds.bottom;
  if (nodes.some(node => node.visibleToUser && (node.clickable || node.scrollable) && covers(node) && !related(node, target))) throw new Error("点击位置与其他可操作控件重叠，无法确认遮挡关系，未点击。");
  return { node: target, x, y };
}

export function resolveScroll(previous: UiNode, snapshot: Observation["snapshot"], packageName: string,
  options: Pick<Extract<DebugCommand, { name: "scroll_node" }>["input"], "direction" | "distance" | "durationMs">) {
  const { target, nodes, bounds } = resolveControl(previous, snapshot, packageName, "scrollable");
  const width = bounds.right - bounds.left, height = bounds.bottom - bounds.top;
  if (Math.min(width, height) < 48) throw new Error("可见滚动区域太小，未滑动。");
  const horizontal = options.direction === "left" || options.direction === "right";
  const length = horizontal ? width : height;
  const half = Math.min(length * options.distance / 2, length / 2 - Math.max(16, length * 0.1));
  if (half * 2 < 64) throw new Error("滑动距离不足 64px，可能被当作点击；请增大距离或选择更大的滚动区域。");
  const sign = options.direction === "down" || options.direction === "right" ? 1 : -1;
  const x = (bounds.left + bounds.right) / 2, y = (bounds.top + bounds.bottom) / 2;
  const action: Extract<DebugInputAction, { kind: "swipe" }> = {
    kind: "swipe", fromX: Math.floor(x + (horizontal ? sign * half : 0)), fromY: Math.floor(y + (horizontal ? 0 : sign * half)),
    toX: Math.floor(x - (horizontal ? sign * half : 0)), toY: Math.floor(y - (horizontal ? 0 : sign * half)), durationMs: options.durationMs,
  };
  // ponytail: conservative straight path; reject nested/overlapping scrollers instead of guessing gesture routing.
  const intersects = (node: UiNode) => node.bounds && Math.max(action.fromX, action.toX) >= node.bounds.left
    && Math.min(action.fromX, action.toX) < node.bounds.right && Math.max(action.fromY, action.toY) >= node.bounds.top
    && Math.min(action.fromY, action.toY) < node.bounds.bottom;
  if (nodes.some(node => node.visibleToUser && intersects(node) && ((!related(node, target) && (node.clickable || node.scrollable))
    || (node.scrollable && node.id.startsWith(`${target.id}/`))))) throw new Error("滑动路径被其他控件或嵌套滚动区域占用，请重新定位滚动控件。");
  return { node: target, action };
}

export class DebugSession {
  readonly state: DebugSessionState;
  private current: Current | null = null;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private lastActionBefore: McpSnapshot | null = null;
  private busy = false;
  private sequence = 0;
  private done: Promise<unknown> = Promise.resolve();
  private readonly directory: string;

  constructor(private readonly options: {
    serial: string; packageName: string; snapshotPath: string; directory: string;
    onEvent: (event: DebugSessionEvent) => void;
    observe?: typeof observeDebugApp; input?: typeof inputDebugApp;
  }) {
    this.state = { id: randomUUID(), serial: options.serial, packageName: options.packageName,
      active: true, busy: false, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), steps: [], evidencePath: null };
    this.directory = join(options.directory, this.state.id);
    this.timer = setTimeout(() => this.stop("授权已到期"), 30 * 60_000);
    this.timer.unref();
  }

  private emit(snapshot?: Observation["snapshot"], selectedNodeId?: string | null) {
    this.options.onEvent({ state: { ...this.state, steps: this.state.steps.map(step => ({ ...step })) }, snapshot, selectedNodeId });
  }

  stop(reason = "已停止自动调试") {
    if (!this.state.active) return;
    this.state.active = false;
    clearTimeout(this.timer);
    this.controller.abort(new Error(reason));
    revokeMcpSnapshot(this.options.snapshotPath);
    this.current = null;
    this.lastActionBefore = null;
    this.emit();
  }

  settled() { return this.done.catch(() => undefined); }

  private accept(observation: Observation, signal: AbortSignal, selectedNodeId: string | null = null): Current {
    signal.throwIfAborted();
    if (!this.state.active) throw new Error("自动调试已停止。");
    if (observation.snapshot.serial !== this.state.serial || observation.target.packageName !== this.state.packageName || observation.snapshot.root?.package !== this.state.packageName || observation.snapshot.error) throw new Error("采集结果不属于授权会话。");
    const entry = publishMcpSnapshot(this.options.snapshotPath, observation.snapshot, selectedNodeId);
    this.current = { entry, target: observation.target };
    this.emit(observation.snapshot, selectedNodeId);
    return this.current;
  }

  private async capture(mode: "fast" | "deep", signal: AbortSignal) {
    signal.throwIfAborted();
    const observation = await (this.options.observe ?? observeDebugApp)(this.state.serial, this.state.packageName, mode, signal);
    signal.throwIfAborted();
    return observation;
  }

  async request(raw: unknown, callerSignal?: AbortSignal): Promise<Record<string, unknown>> {
    const command = debugCommand.parse(raw);
    if (command.name === "get_debug_session") return { ...this.state, steps: this.state.steps.slice(-20), snapshotId: this.current?.entry.id ?? null };
    if (command.input.sessionId !== this.state.id || !this.state.active) throw new Error("会话已结束或不匹配，请在桌面重新授权。");
    if (command.name === "stop_debug_session") { this.stop(); return { stopped: true }; }
    // ponytail: one desktop/device session at a time; reject concurrent actions instead of queuing stale clicks.
    if (this.busy) throw new Error("另一个调试操作正在执行，请等待完成后重试。");
    this.busy = this.state.busy = true;
    const limit = command.name === "wait_for_ui" ? command.input.timeoutMs : command.name === "capture_ui" && command.input.mode === "deep" ? 120_000 : 45_000;
    const timeout = AbortSignal.timeout(limit);
    const signal = AbortSignal.any([this.controller.signal, timeout, ...(callerSignal ? [callerSignal] : [])]);
    const step: DebugStep = { id: ++this.sequence, time: new Date().toISOString(), action: command.name, input: command.input,
      status: "running", message: command.name === "wait_for_ui" ? `等待 ${JSON.stringify(command.input.selector)} ${command.input.state}` : "执行中", beforeId: this.current?.entry.id };
    if (command.name === "tap_node" || command.name === "scroll_node" || command.name === "press_back") step.dispatchState = "not_sent";
    this.state.steps.push(step);
    this.state.steps = this.state.steps.slice(-100);
    this.emit();
    const before = command.name === "wait_for_ui" ? this.lastActionBefore ?? this.current?.entry : this.current?.entry;
    const run = async () => {
      let outcome: Record<string, unknown> = {};
      try {
        const result = await this.perform(command, signal, step);
        signal.throwIfAborted();
        step.status = "done";
        step.message = String(result.message ?? "完成");
        step.afterId = this.current?.entry.id;
        outcome = { ...result, stepId: step.id };
      } catch (error) {
        step.status = "failed";
        step.message = timeout.aborted ? "等待超时，未验证成功；操作可能已经发出，请重新观察，不要盲目重试。" : message(error);
        step.afterId = this.current?.entry.id;
        if (this.state.active) {
          try {
            // Retain only the latest failure per session; both snapshots carry their actual capture timestamps.
            const path = join(this.directory, "last-failure.json");
            writePrivateJson(path, { step, request: command, steps: this.state.steps,
              before: step.dispatchState ? this.lastActionBefore ?? before ?? null : before ?? null, after: this.current?.entry ?? null });
            this.state.evidencePath = path;
          } catch (saveError) { step.message += ` 留证失败：${message(saveError)}`; }
        }
        outcome = { isError: true, verified: false, stepId: step.id, message: step.message, snapshotId: this.current?.entry.id ?? null, evidencePath: this.state.evidencePath,
          ...(step.dispatchState ? { dispatchState: step.dispatchState } : {}) };
      } finally {
        this.busy = this.state.busy = false;
        try { writePrivateJson(join(this.directory, "steps.json"), this.state); }
        catch (error) {
          outcome.recordingWarning = `记录保存失败：${message(error)}`;
          step.message += ` ${outcome.recordingWarning}`;
        }
        this.emit();
      }
      return { ...outcome, message: step.message };
    };
    this.done = run();
    return this.done as Promise<Record<string, unknown>>;
  }

  private async perform(command: Exclude<DebugCommand, { name: "get_debug_session" | "stop_debug_session" }>, signal: AbortSignal, step: DebugStep): Promise<Record<string, unknown>> {
    if (command.name === "capture_ui") {
      const { entry } = this.accept(await this.capture(command.input.mode, signal), signal);
      return { snapshotId: entry.id, mode: command.input.mode, nodeCount: entry.snapshot.nodeCount, message: "页面已更新，可搜索控件或读取截图。" };
    }
    if (command.name === "tap_node" || command.name === "scroll_node" || command.name === "press_back") {
      this.lastActionBefore = null;
      const old = this.current;
      if (!old || old.entry.id !== command.input.snapshotId) throw new Error("快照已过期，请重新采集和定位。");
      if (old.entry.snapshot.captureMode !== "fast") throw new Error("操作必须基于轻量实时快照；请先 capture_ui(mode=fast)。");
      if (Date.now() - Date.parse(old.entry.sharedAt) > 30_000) throw new Error("快照超过 30 秒，请重新采集。");
      const previous = command.name === "press_back" ? null : flattenNodes(old.entry.snapshot.root!).get(command.input.nodeId);
      if (command.name !== "press_back" && !previous) throw new Error("没有这个控件。");
      const fresh = await this.capture("fast", signal);
      const current = this.accept(fresh, signal);
      if (old.target.windowId !== fresh.target.windowId || old.target.component !== fresh.target.component) throw new Error("窗口已变化，未执行操作。");
      const frame = fresh.snapshot.captureGeometry?.afterScreenshot, oldFrame = old.entry.snapshot.captureGeometry?.afterScreenshot;
      if (assessCaptureGeometry(fresh.snapshot.captureGeometry).status !== "checked" || !frame || !oldFrame
        || frame.width !== oldFrame.width || frame.height !== oldFrame.height || frame.rotation !== oldFrame.rotation) throw new Error("屏幕方向或尺寸变化，未执行操作。");
      let action: DebugInputAction = { kind: "back" };
      let metadata: Record<string, unknown> = {};
      let description = "已发送返回键";
      if (command.name === "tap_node") {
        const { node, x, y } = resolveTap(previous!, fresh.snapshot, this.state.packageName);
        action = { kind: "tap", x, y };
        metadata = { target: nodeDisplayLabel(node), x, y };
        description = `已点击 ${nodeDisplayLabel(node)} (${x}, ${y})`;
        this.emit(fresh.snapshot, node.id);
      } else if (command.name === "scroll_node") {
        const resolved = resolveScroll(previous!, fresh.snapshot, this.state.packageName, command.input);
        action = resolved.action;
        metadata = { target: nodeDisplayLabel(resolved.node), direction: command.input.direction, gesture: action };
        description = `已滚动 ${nodeDisplayLabel(resolved.node)}`;
        this.emit(fresh.snapshot, resolved.node.id);
      }
      this.lastActionBefore = current.entry;
      step.beforeId = current.entry.id;
      signal.throwIfAborted();
      // A sent/uncertain input invalidates its snapshot, including after client cancellation.
      this.current = null;
      revokeMcpSnapshot(this.options.snapshotPath);
      step.dispatchState = "unknown";
      await (this.options.input ?? inputDebugApp)(this.state.serial, fresh.target, action, frame, signal);
      step.dispatchState = "sent";
      const after = this.accept(await this.capture("fast", signal), signal);
      return { snapshotId: after.entry.id, dispatched: true, dispatchState: step.dispatchState, verified: false, ...metadata,
        message: `${description}并重新观察；尚未验证预期结果，请调用 wait_for_ui。` };
    }
    let confirmations = 0;
    while (true) {
      signal.throwIfAborted();
      const { entry } = this.accept(await this.capture("fast", signal), signal);
      const matches = [...flattenNodes(entry.snapshot.root!).values()].filter(node => node.package === this.state.packageName && node.visibleToUser
        && matchesDebugSelector(node, command.input.selector));
      const { state } = command.input;
      const met = state === "absent" ? matches.length === 0 : state === "visible" ? matches.length > 0
        : matches.length > 0 && matches.every(node => node.enabled === (state === "enabled"));
      confirmations = met ? confirmations + 1 : 0;
      if (confirmations >= 2) {
        this.lastActionBefore = null;
        if (matches[0]) this.emit(entry.snapshot, matches[0].id);
        return { verified: true, snapshotId: entry.id, matchCount: matches.length, message: "连续两次观察符合预期。" };
      }
      await delay(350, undefined, { signal });
    }
  }
}
