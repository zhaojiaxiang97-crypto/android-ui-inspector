import { setTimeout as delay } from "node:timers/promises";
import { matchesDebugSelector, type DebugCommand } from "../../shared/debug-protocol";
import { assessCaptureGeometry } from "../../shared/screen-coordinates";
import { flattenNodes, nodeDisplayLabel } from "../../shared/tree-utils";
import type { DebugSessionState, DebugStep, DebugStepError, FastCaptureBackend } from "../../shared/types";
import { inputDebugApp, type DebugObserver, type DebugInputAction } from "./device-actions";
import { publishMcpSnapshot, revokeMcpSnapshot, type McpSnapshot } from "./mcp-snapshot";
import { resolveTap, resolveParentTap, resolveScroll } from "./debug-target-resolution";
import { DebugTaskExecution } from "./debug-task-execution";
import type { Current, Observation, StepCommand, StepContext } from "./debug-step-context";

/** Owns accepted observations and input intent, never authorization or the in-flight request. */
export class DebugStepExecutor {
  private current: Current | null = null;
  private lastActionBefore: McpSnapshot | null = null;
  private inputRequested = false;
  private readonly tasks: DebugTaskExecution;

  constructor(private readonly state: DebugSessionState, private readonly options: {
    snapshotPath: string; observe: DebugObserver; input?: typeof inputDebugApp;
    events: { phase(context: StepContext, phase: DebugStepError["phase"]): void; emit(snapshot?: Observation["snapshot"], selectedNodeId?: string | null): void };
  }) { this.tasks = new DebugTaskExecution(state); }

  get snapshotId() { return this.current?.entry.id ?? null; }

  beginStep(command: StepCommand, step: DebugStep): StepContext {
    if (command.name === "tap_node" || command.name === "scroll_node" || command.name === "press_back") this.inputRequested = true;
    const metadata = command.name === "define_debug_task" || command.name === "check_debug_task";
    return { step, started: performance.now(),
      phase: command.name === "capture_ui" ? "capture" : command.name === "wait_for_ui" || metadata ? "verify" : "locate",
      before: metadata ? null : (command.name === "wait_for_ui" ? this.lastActionBefore ?? this.current?.entry : this.current?.entry) ?? null,
      beforeFreshness: metadata ? "current" : "previous", after: null, previousAfter: metadata ? null : this.current?.entry ?? null, invalidatedAfter: metadata };
  }

  stop() {
    try { revokeMcpSnapshot(this.options.snapshotPath); }
    finally { this.current = null; this.lastActionBefore = null; }
  }

  finishTaskCheck(context: StepContext, reason: string) { return this.tasks.finish(context, reason); }

  execute(command: StepCommand, signal: AbortSignal, context: StepContext): Promise<Record<string, unknown>> {
    if (command.name === "check_debug_task") return this.checkTask(command.input, signal, context);
    signal.throwIfAborted();
    switch (command.name) {
      case "define_debug_task": return Promise.resolve(this.tasks.define(command.input, context, this.inputRequested));
      case "capture_ui": return this.captureUi(command.input, signal, context);
      case "tap_node": case "scroll_node": case "press_back": return this.input(command, signal, context);
      case "wait_for_ui": return this.waitForUi(command.input, signal, context);
      default: { const exhaustive: never = command; throw new Error(`未知调试命令：${String(exhaustive)}`); }
    }
  }

  private emit(snapshot?: Observation["snapshot"], selectedNodeId?: string | null) { this.options.events.emit(snapshot, selectedNodeId); }
  private phase(context: StepContext, phase: DebugStepError["phase"]) { this.options.events.phase(context, phase); }

  private accept(observation: Observation, signal: AbortSignal, context: StepContext, selectedNodeId: string | null = null): Current {
    signal.throwIfAborted();
    if (!this.state.active) throw new Error("自动调试已停止。");
    if (observation.snapshot.serial !== this.state.serial || observation.target.packageName !== this.state.packageName || observation.snapshot.root?.package !== this.state.packageName || observation.snapshot.error) throw new Error("采集结果不属于授权会话。");
    const snapshot = { ...observation.snapshot, root: observation.snapshot.root ? { ...observation.snapshot.root,
      attributes: { ...observation.snapshot.root.attributes,
        "debug-observation-component": observation.target.component,
        "debug-observation-window-id": observation.target.windowId,
        "debug-observation-activity-record-id": observation.target.activityRecordId ?? "" } } : null };
    const entry = publishMcpSnapshot(this.options.snapshotPath, snapshot, selectedNodeId);
    const current = { entry, target: observation.target };
    this.current = current;
    if (context.task) this.tasks.observe(context, entry, observation);
    else context.after = entry;
    this.emit(observation.snapshot, selectedNodeId);
    signal.throwIfAborted();
    return current;
  }

  private async capture(mode: "fast" | "deep", signal: AbortSignal, backend: FastCaptureBackend = "uiautomator") {
    signal.throwIfAborted();
    const observation = await this.options.observe(this.state.serial, this.state.packageName, mode, signal, backend);
    signal.throwIfAborted();
    return observation;
  }

  private async checkTask(input: Extract<DebugCommand, { name: "check_debug_task" }>["input"], signal: AbortSignal,
    context: StepContext): Promise<Record<string, unknown>> {
    const immediate = this.tasks.beginCheck(input, signal, context);
    if (immediate) return immediate;
    if ((this.current?.entry ?? this.lastActionBefore)?.snapshot.inspectionSource === "accessibility-helper")
      throw new Error("Helper 当前不支持任务验收；请先显式采集 UIAutomator 快照，验收不会自动换源。");
    this.phase(context, "capture");
    this.accept(await this.capture("fast", signal, "uiautomator"), signal, context);
    this.phase(context, "verify");
    await delay(350, undefined, { signal });
    this.phase(context, "capture");
    this.accept(await this.capture("fast", signal, "uiautomator"), signal, context);
    this.phase(context, "verify");
    signal.throwIfAborted();
    return this.tasks.result(context);
  }

  prepareCaptureSource(command: StepCommand, context: StepContext) {
    if (command.name !== "capture_ui") return;
    const previous = this.current?.entry ?? this.lastActionBefore;
    const sourceKey = (snapshot: McpSnapshot["snapshot"]) => snapshot.captureMode === "deep" ? "deep"
      : snapshot.inspectionSource === "accessibility-helper" ? "accessibility-helper" : "uiautomator";
    const nextKey = command.input.mode === "deep" ? "deep" : command.input.backend;
    if (previous && sourceKey(previous.snapshot) !== nextKey) {
      revokeMcpSnapshot(this.options.snapshotPath);
      this.current = null;
      this.lastActionBefore = null;
      context.invalidatedAfter = true;
      this.emit();
    }
  }

  private async captureUi(input: Extract<DebugCommand, { name: "capture_ui" }>["input"], signal: AbortSignal, context: StepContext) {
    this.phase(context, "capture");
    const { entry } = this.accept(await this.capture(input.mode, signal, input.backend), signal, context);
    return { snapshotId: entry.id, mode: input.mode, source: entry.snapshot.inspectionSource ?? "unknown",
      nodeCount: entry.snapshot.nodeCount, message: "页面已更新，可搜索控件或读取截图。" };
  }

  private async input(command: Extract<StepCommand, { name: "tap_node" | "scroll_node" | "press_back" }>, signal: AbortSignal, context: StepContext) {
    const { step } = context;
    this.lastActionBefore = null;
    const old = this.current;
    if (!old || old.entry.id !== command.input.snapshotId) throw new Error("快照已过期，请重新采集和定位。");
    if (old.entry.snapshot.inspectionSource === "accessibility-helper") throw new Error("Helper 当前仅支持只读观察；操作前请显式采集 UIAutomator 快照并重新定位。");
    if (old.entry.snapshot.captureMode !== "fast") throw new Error("操作必须基于轻量实时快照；请先 capture_ui(mode=fast)。");
    if (Date.now() - Date.parse(old.entry.sharedAt) > 30_000) throw new Error("快照超过 30 秒，请重新采集。");
    const previous = command.name === "press_back" ? null : flattenNodes(old.entry.snapshot.root!).get(command.input.nodeId);
    if (command.name !== "press_back" && !previous) throw new Error("没有这个控件。");
    this.phase(context, "capture");
    const fresh = await this.capture("fast", signal);
    const current = this.accept(fresh, signal, context);
    this.phase(context, "locate");
    if (old.target.windowId !== fresh.target.windowId || old.target.component !== fresh.target.component) throw new Error("窗口已变化，未执行操作。");
    const frame = fresh.snapshot.captureGeometry?.afterScreenshot, oldFrame = old.entry.snapshot.captureGeometry?.afterScreenshot;
    if (assessCaptureGeometry(fresh.snapshot.captureGeometry).status !== "checked" || !frame || !oldFrame
      || frame.width !== oldFrame.width || frame.height !== oldFrame.height || frame.rotation !== oldFrame.rotation) throw new Error("屏幕方向或尺寸变化，未执行操作。");
    let action: DebugInputAction = { kind: "back" };
    let targetNodeId: string | undefined, anchorNodeId: string | undefined;
    let metadata: Record<string, unknown> = {};
    let description = "已发送返回键";
    if (command.name === "tap_node") {
      const parent = command.input.target === "clickable-parent"
        ? resolveParentTap(previous!, old.entry.snapshot, fresh.snapshot, this.state.packageName) : null;
      const resolved = parent ?? resolveTap(previous!, fresh.snapshot, this.state.packageName);
      const { node, x, y } = resolved;
      action = { kind: "tap", x, y };
      targetNodeId = node.id; anchorNodeId = parent?.anchor.id ?? node.id;
      const label = command.input.target === "clickable-parent" ? `${nodeDisplayLabel(previous!)}的父控件` : nodeDisplayLabel(node);
      metadata = { target: label, targetNodeId: node.id, anchorNodeId, x, y };
      description = `已点击 ${label} (${x}, ${y})`;
      this.emit(fresh.snapshot, node.id);
    } else if (command.name === "scroll_node") {
      const resolved = resolveScroll(previous!, fresh.snapshot, this.state.packageName, command.input);
      action = resolved.action;
      targetNodeId = resolved.node.id;
      metadata = { target: nodeDisplayLabel(resolved.node), direction: command.input.direction, gesture: action };
      description = `已滚动 ${nodeDisplayLabel(resolved.node)}`;
      this.emit(fresh.snapshot, resolved.node.id);
    }
    this.lastActionBefore = current.entry;
    context.before = current.entry;
    context.beforeFreshness = "current";
    step.beforeId = current.entry.id;
    // Preserve the resolved input even if its receipt or the following observation fails.
    step.resolvedInput = { action: { ...action }, frame: { ...frame },
      ...(targetNodeId ? { targetNodeId } : {}), ...(anchorNodeId ? { anchorNodeId } : {}) };
    signal.throwIfAborted();
    // A sent/uncertain input invalidates its snapshot, including after client cancellation.
    this.current = null;
    context.after = null;
    context.invalidatedAfter = true;
    revokeMcpSnapshot(this.options.snapshotPath);
    step.dispatchState = "unknown";
    this.phase(context, "input");
    await (this.options.input ?? inputDebugApp)(this.state.serial, fresh.target, action, frame, signal,
      evidence => { step.inputEvidence = evidence; });
    step.dispatchState = "sent";
    signal.throwIfAborted();
    this.phase(context, "capture");
    const after = this.accept(await this.capture("fast", signal), signal, context);
    return { snapshotId: after.entry.id, dispatched: true, dispatchState: step.dispatchState, verified: false, ...metadata,
      message: `${description}并重新观察；尚未验证预期结果，请调用 wait_for_ui 或 check_debug_task。` };
  }

  private async waitForUi(input: Extract<DebugCommand, { name: "wait_for_ui" }>["input"], signal: AbortSignal, context: StepContext) {
    if ((this.current?.entry ?? this.lastActionBefore)?.snapshot.inspectionSource === "accessibility-helper")
      throw new Error("Helper 当前不支持 wait_for_ui；请显式采集 UIAutomator 快照后再验证。");
    let confirmations = 0;
    while (true) {
      signal.throwIfAborted();
      this.phase(context, "capture");
      const { entry } = this.accept(await this.capture("fast", signal), signal, context);
      this.phase(context, "verify");
      const matches = [...flattenNodes(entry.snapshot.root!).values()].filter(node => node.package === this.state.packageName && node.visibleToUser
        && matchesDebugSelector(node, input.selector));
      const { state } = input;
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
