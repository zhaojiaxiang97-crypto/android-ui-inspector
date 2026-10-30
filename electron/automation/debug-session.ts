import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { debugCommand, matchesDebugSelector, type DebugCommand } from "../../shared/debug-protocol";
import { assessCaptureGeometry, clipBounds } from "../../shared/screen-coordinates";
import { flattenNodes, nodeDisplayLabel } from "../../shared/tree-utils";
import type { DebugSessionEvent, DebugSessionState, DebugStep, DebugStepError, FastCaptureBackend, UiNode } from "../../shared/types";
import { observeDebugApp, inputDebugApp, type DebugInputAction } from "./device-actions";
import { type DebugTarget } from "../device/target";
import { DebugInputError } from "../device/debug-input";
import { publishMcpSnapshot, revokeMcpSnapshot, writePrivateJson, type McpSnapshot } from "./mcp-snapshot";
import { DebugEvidenceWriter, appendDebugRecordingErrors, debugEvidenceSnapshot, type DebugEvidenceObservation } from "./debug-evidence";
import { evaluateDebugTaskConditions } from "../../shared/debug-task-checker";
import type { DebugTaskAssessment, DebugTaskCondition, DebugTaskEvidence, DebugTaskCheckResult } from "../../shared/debug-task";

type Observation = Awaited<ReturnType<typeof observeDebugApp>>;
type Current = { entry: McpSnapshot; target: DebugTarget };
const message = (error: unknown) => error instanceof Error ? error.message.slice(0, 16000) : "操作失败。";
type StepContext = {
  step: DebugStep;
  started: number; phase: DebugStepError["phase"]; before: McpSnapshot | null;
  beforeFreshness: "current" | "previous"; after: McpSnapshot | null; previousAfter: McpSnapshot | null;
  invalidatedAfter: boolean;
  task?: { taskId: string; checkpointId: string | null; conditions: DebugTaskCondition[];
    first: DebugTaskEvidence | null; second: DebugTaskEvidence | null };
};
const compatibilityLimit = 8 * 1024 * 1024;
function writeCompatibility(path: string, value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value)) > compatibilityLimit) throw new Error("兼容记录超过8MiB上限，未写入。");
  writePrivateJson(path, value);
}

function failure(error: unknown, context: StepContext, timedOut: boolean, cancelled: boolean): DebugStepError {
  if (timedOut) return { category: "timeout", code: "timeout", phase: context.phase, message: "操作超过本次时限，未验证成功。" };
  if (cancelled) return { category: "cancelled", code: "cancelled", phase: context.phase, message: message(error) };
  if (error instanceof DebugInputError) return { category: "input", code: error.evidence.classification, phase: "input", message: message(error) };
  return { category: context.phase, code: `${context.phase}_failed`, phase: context.phase, message: message(error) };
}

export function sameControl(a: UiNode, b: UiNode) {
  return ["package", "className", "resourceId", "text", "contentDesc"].every(key => a[key as keyof UiNode] === b[key as keyof UiNode])
    && a.bounds && b.bounds && ["left", "top", "right", "bottom"].every(key => a.bounds![key as keyof typeof a.bounds] === b.bounds![key as keyof typeof b.bounds]);
}

function resolveControl(previous: UiNode, snapshot: Observation["snapshot"], packageName: string, capability: "clickable" | "scrollable" | null) {
  if (!previous.resourceId && !previous.text && !previous.contentDesc) throw new Error("控件缺少稳定名称或 ID，无法安全自动操作。");
  const nodes = [...flattenNodes(snapshot.root!).values()];
  const matches = nodes.filter(node => sameControl(previous, node) && node.package === packageName && node.visibleToUser);
  if (matches.length !== 1) throw new Error("控件已移动、改变或匹配不唯一，请重新观察和定位。");
  const target = matches[0];
  if ((capability && !target[capability]) || !target.enabled || !target.bounds) throw new Error(capability === "clickable"
    ? "控件不可点击或未启用，请定位实际可点击的父控件。" : "控件不可滚动或未启用，请定位实际可滚动的容器。");
  const size = snapshot.captureGeometry?.screenshotSize;
  const bounds = size && clipBounds(target.bounds, size);
  if (!bounds) throw new Error("控件不在屏幕内。");
  return { target, nodes, bounds };
}

const related = (a: UiNode, b: UiNode) => a.id === b.id || a.id.startsWith(`${b.id}/`) || b.id.startsWith(`${a.id}/`);

export function resolveTap(previous: UiNode, snapshot: Observation["snapshot"], packageName: string) {
  const { target, nodes, bounds } = resolveControl(previous, snapshot, packageName, "clickable");
  return checkedTap(target, nodes, bounds);
}

function checkedTap(target: UiNode, nodes: UiNode[], bounds: NonNullable<ReturnType<typeof clipBounds>>) {
  const x = Math.floor((bounds.left + bounds.right) / 2), y = Math.floor((bounds.top + bounds.bottom) / 2);
  const covers = (node: UiNode) => node.bounds && x >= node.bounds.left && x < node.bounds.right && y >= node.bounds.top && y < node.bounds.bottom;
  if (nodes.some(node => node.visibleToUser && (node.clickable || node.scrollable) && covers(node) && !related(node, target))) throw new Error("点击位置与其他可操作控件重叠，无法确认遮挡关系，未点击。");
  return { node: target, x, y };
}

// Explicit opt-in: a uniquely named label anchors an otherwise anonymous row.
// Do not turn the default tap into an automatic ancestor fallback.
export function resolveParentTap(previous: UiNode, before: Observation["snapshot"], after: Observation["snapshot"], packageName: string) {
  const { target: anchor, nodes, bounds: anchorBounds } = resolveControl(previous, after, packageName, null);
  if (previous.clickable || anchor.clickable) throw new Error("目标本身可点击，请使用 self；未自动改选父控件。");
  const identity = (node: UiNode) => ["package", "className", "resourceId", "text", "contentDesc"]
    .every(key => previous[key as keyof UiNode] === node[key as keyof UiNode]);
  for (const tree of [before, after]) {
    if ([...flattenNodes(tree.root!).values()].filter(node => node.visibleToUser && identity(node)).length !== 1)
      throw new Error("文字锚点匹配不唯一，未点击父控件。");
  }
  const path = (root: UiNode, id: string) => {
    const parents = new Map<UiNode, UiNode | null>([[root, null]]), stack = [root];
    let found: UiNode | undefined;
    while (stack.length) {
      const node = stack.pop()!;
      if (node.id === id) { if (found) throw new Error("节点 ID 不唯一，未点击。"); found = node; }
      for (const child of node.children) { parents.set(child, node); stack.push(child); }
    }
    if (!found) throw new Error("文字锚点已消失，未点击。");
    const result: UiNode[] = [];
    for (let parent = parents.get(found); parent; parent = parents.get(parent)) {
      result.push(parent);
      if (parent.clickable) return result;
    }
    throw new Error("文字锚点没有可点击父控件。");
  };
  const oldPath = path(before.root!, previous.id), newPath = path(after.root!, anchor.id);
  if (oldPath.length !== newPath.length || oldPath.some((node, index) => !sameControl(node, newPath[index])
    || ["enabled", "visibleToUser", "clickable", "scrollable"].some(key => node[key as keyof UiNode] !== newPath[index][key as keyof UiNode])))
    throw new Error("文字与父控件的关系或位置已变化，未点击。");
  const target = newPath.at(-1)!;
  if (newPath.some(node => node.package !== packageName || !node.enabled || !node.visibleToUser)
    || target.scrollable || !target.bounds) throw new Error("父控件不可用或属于滚动区域，未点击。");
  const bounds = clipBounds(target.bounds, after.captureGeometry!.screenshotSize!);
  if (!bounds || anchorBounds.left < bounds.left || anchorBounds.top < bounds.top
    || anchorBounds.right > bounds.right || anchorBounds.bottom > bounds.bottom)
    throw new Error("文字不在父控件可见区域内，未点击。");
  const hit = checkedTap(target, nodes, bounds);
  if (nodes.some(node => node.visibleToUser && node.clickable && node.id.startsWith(`${target.id}/`)
    && node.bounds && hit.x >= node.bounds.left && hit.x < node.bounds.right && hit.y >= node.bounds.top && hit.y < node.bounds.bottom))
    throw new Error("父控件点击位置存在可操作子控件，未点击。");
  return { ...hit, anchor };
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
  private readonly evidence: DebugEvidenceWriter;
  private pending: StepContext | null = null;
  private inputRequested = false;

  constructor(private readonly options: {
    serial: string; packageName: string; snapshotPath: string; directory: string;
    onEvent: (event: DebugSessionEvent) => void;
    observe?: typeof observeDebugApp; input?: typeof inputDebugApp;
  }) {
    this.state = { id: randomUUID(), serial: options.serial, packageName: options.packageName,
      active: true, busy: false, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), steps: [], evidencePath: null, reportPath: null, stopReason: null, task: null };
    this.directory = join(options.directory, this.state.id);
    this.evidence = new DebugEvidenceWriter(this.directory, this.state);
    this.timer = setTimeout(() => this.stop("授权已到期"), 30 * 60_000);
    this.timer.unref();
  }

  private emit(snapshot?: Observation["snapshot"], selectedNodeId?: string | null) {
    this.options.onEvent({ state: structuredClone(this.state), snapshot, selectedNodeId });
  }

  private finishTaskCheck(context: StepContext, reason?: string): DebugTaskCheckResult {
    const task = context.task!;
    const assessment: DebugTaskAssessment = evaluateDebugTaskConditions(task.conditions, task.first, task.second, this.state.packageName);
    if (reason) {
      assessment.status = "insufficient_evidence"; assessment.reason = reason.slice(0, 16000);
      assessment.conditions = assessment.conditions.map(item => ({ ...item, status: "insufficient_evidence", reason: assessment.reason }));
    }
    const check: DebugTaskCheckResult = { taskId: task.taskId, checkpointId: task.checkpointId, stepId: context.step.id,
      checkedAt: new Date().toISOString(), ...assessment,
      observations: { first: task.first?.observation ?? null, second: task.second?.observation ?? null } };
    context.step.taskCheck = check; context.step.verified = check.status === "passed";
    const record = this.state.task!;
    record.checks = [...record.checks.filter(item => item.checkpointId !== check.checkpointId), check].sort((a, b) => {
      const order = (id: string | null) => id === null ? record.definition.checkpoints.length
        : record.definition.checkpoints.findIndex(item => item.id === id);
      return order(a.checkpointId) - order(b.checkpointId);
    });
    return check;
  }

  private invalidateTaskCheck(step: DebugStep, reason: string) {
    if (!step.taskCheck) return;
    const check = step.taskCheck;
    check.status = "insufficient_evidence"; check.reason = reason.slice(0, 16000);
    check.conditions = check.conditions.map(item => ({ ...item, status: "insufficient_evidence", reason: check.reason }));
    step.verified = false;
    const saved = this.state.task?.checks.find(item => item.stepId === step.id);
    if (saved) Object.assign(saved, structuredClone(check));
  }

  private recordingFailure(step: DebugStep | undefined, code: string, error: unknown) {
    const issue: DebugStepError = { category: "recording", code, phase: "recording", message: message(error) };
    if (step) {
      appendDebugRecordingErrors(step, [issue]);
      this.invalidateTaskCheck(step, "任务验收的记录保存失败，无法保留完整证据。");
      const summary = step.taskCheck && step.status === "done" ? step.taskCheck.reason : step.message;
      step.message = `${summary} 记录保存失败：${issue.message}`.slice(0, 16000);
    }
    return issue;
  }

  private recordEvidence(context: StepContext) {
    const before: DebugEvidenceObservation = { entry: context.before, freshness: context.beforeFreshness,
      reason: context.beforeFreshness === "previous" && context.before ? "保留操作开始前已有的观察。" : null };
    const after: DebugEvidenceObservation = context.after ? { entry: context.after, freshness: "current", reason: null }
      : !context.task && !context.invalidatedAfter && context.previousAfter ? { entry: context.previousAfter, freshness: "previous",
        reason: "本次未接受新的观察；这是此前页面，不能作为操作后结果。" }
        : { entry: null, freshness: "missing", reason: "本次未接受到操作后的新观察。" };
    try {
      const errors = this.evidence.record(this.state, this.sequence, { step: context.step,
        finishedAt: new Date().toISOString(), durationMs: Math.max(0, Math.round(performance.now() - context.started)),
        verified: context.step.verified ?? null, before: { snapshotId: null, freshness: "missing", reason: null },
        after: { snapshotId: null, freshness: "missing", reason: null } }, before, after);
      this.state.reportPath = this.evidence.path;
      appendDebugRecordingErrors(context.step, errors);
    } catch (error) { this.recordingFailure(context.step, "report_write_failed", error); }
  }

  stop(reason = "已停止自动调试") {
    if (!this.state.active) return;
    this.state.active = false;
    this.state.stopReason = reason;
    clearTimeout(this.timer);
    this.controller.abort(new Error(reason));
    try { revokeMcpSnapshot(this.options.snapshotPath); }
    catch (error) { this.recordingFailure(this.state.steps.at(-1), "share_cleanup_failed", error); }
    this.current = null;
    this.lastActionBefore = null;
    if (this.pending) {
      this.pending.step.status = "failed";
      this.pending.step.verified = false;
      this.pending.step.message = reason;
      this.pending.step.error = failure(new Error(reason), this.pending, false, true);
      if (this.pending.task) this.finishTaskCheck(this.pending, `任务验收已停止：${reason}`);
      this.recordEvidence(this.pending);
    } else {
      try {
        const errors = this.evidence.saveSession(this.state, this.sequence); this.state.reportPath = this.evidence.path;
        const last = this.state.steps.at(-1);
        if (last) appendDebugRecordingErrors(last, errors);
      }
      catch (error) { this.recordingFailure(this.state.steps.at(-1), "report_write_failed", error); }
    }
    try { writeCompatibility(join(this.directory, "steps.json"), this.state); }
    catch (error) { this.recordingFailure(this.state.steps.at(-1), "steps_write_failed", error); }
    this.emit();
  }

  settled() { return this.done.catch(() => undefined); }

  private accept(observation: Observation, signal: AbortSignal, context: StepContext, selectedNodeId: string | null = null): Current {
    signal.throwIfAborted();
    if (!this.state.active) throw new Error("自动调试已停止。");
    if (observation.snapshot.serial !== this.state.serial || observation.target.packageName !== this.state.packageName || observation.snapshot.root?.package !== this.state.packageName || observation.snapshot.error) throw new Error("采集结果不属于授权会话。");
    const entry = publishMcpSnapshot(this.options.snapshotPath, observation.snapshot, selectedNodeId);
    const current = { entry, target: observation.target };
    this.current = current;
    if (context.task) {
      const evidence: DebugTaskEvidence = { snapshot: observation.snapshot, observation: { snapshotId: entry.id, capturedAt: entry.sharedAt,
        component: observation.target.component, windowId: observation.target.windowId, activityRecordId: observation.target.activityRecordId ?? null } };
      if (!context.task.first) {
        context.task.first = evidence; context.before = entry; context.beforeFreshness = "current";
        context.step.beforeId = entry.id;
      } else { context.task.second = evidence; context.after = entry; }
    } else context.after = entry;
    this.emit(observation.snapshot, selectedNodeId);
    signal.throwIfAborted();
    return current;
  }

  private async capture(mode: "fast" | "deep", signal: AbortSignal, backend: FastCaptureBackend = "uiautomator") {
    signal.throwIfAborted();
    const observation = await (this.options.observe ?? observeDebugApp)(this.state.serial, this.state.packageName, mode, signal, backend);
    signal.throwIfAborted();
    return observation;
  }

  private async checkTask(input: Extract<DebugCommand, { name: "check_debug_task" }>["input"], signal: AbortSignal,
    context: StepContext): Promise<Record<string, unknown>> {
    const task = this.state.task;
    if (!task || task.id !== input.taskId) throw new Error("任务不存在或 taskId 不匹配，请使用本会话定义的任务编号。");
    const checkpointId = input.checkpointId ?? null;
    const index = checkpointId === null ? task.definition.checkpoints.length
      : task.definition.checkpoints.findIndex(item => item.id === checkpointId);
    if (index < 0) throw new Error("没有这个验收阶段。");
    const passed = (id: string) => task.checks.some(item => item.checkpointId === id && item.status === "passed");
    const current = task.definition.checkpoints.findIndex(item => !passed(item.id));
    if (checkpointId !== null && current >= 0 && index > current) throw new Error("阶段必须按定义顺序检查，请先完成当前阶段。");
    task.checks = task.checks.filter(check => check.checkpointId !== null
      && task.definition.checkpoints.findIndex(item => item.id === check.checkpointId) < index);
    context.task = { taskId: task.id, checkpointId, conditions: structuredClone(checkpointId === null
      ? task.definition.finalConditions : task.definition.checkpoints[index].conditions), first: null, second: null };
    const result = (reason?: string) => {
      const taskResult = this.finishTaskCheck(context, reason);
      return { taskId: task.id, taskResult, verified: taskResult.status === "passed",
        snapshotId: context.after?.id ?? null, message: taskResult.reason };
    };
    signal.throwIfAborted();
    if (checkpointId === null && task.definition.checkpoints.some(item => !passed(item.id)))
      return result("最终验收需要所有前置阶段都有有效的通过证据；本次没有采集页面。");
    if ((this.current?.entry ?? this.lastActionBefore)?.snapshot.inspectionSource === "accessibility-helper")
      throw new Error("Helper 当前不支持任务验收；请先显式采集 UIAutomator 快照，验收不会自动换源。");
    context.phase = "capture";
    this.accept(await this.capture("fast", signal, "uiautomator"), signal, context);
    context.phase = "verify";
    await delay(350, undefined, { signal });
    context.phase = "capture";
    this.accept(await this.capture("fast", signal, "uiautomator"), signal, context);
    context.phase = "verify";
    signal.throwIfAborted();
    return result();
  }

  async request(raw: unknown, callerSignal?: AbortSignal): Promise<Record<string, unknown>> {
    const command = debugCommand.parse(raw);
    if (command.name === "get_debug_session") return { ...structuredClone(this.state), steps: structuredClone(this.state.steps.slice(-20)), snapshotId: this.current?.entry.id ?? null };
    if (command.input.sessionId !== this.state.id || !this.state.active) throw new Error("会话已结束或不匹配，请在桌面重新授权。");
    if (command.name === "stop_debug_session") { this.stop("CLI / MCP 请求停止自动调试"); return { stopped: true }; }
    // ponytail: one desktop/device session at a time; reject concurrent actions instead of queuing stale clicks.
    if (this.busy) throw new Error("另一个调试操作正在执行，请等待完成后重试。");
    if (command.name === "tap_node" || command.name === "scroll_node" || command.name === "press_back") this.inputRequested = true;
    this.busy = this.state.busy = true;
    const limit = command.name === "check_debug_task" ? 30_000 : command.name === "wait_for_ui" ? command.input.timeoutMs : command.name === "capture_ui" && command.input.mode === "deep" ? 120_000 : 45_000;
    const timeout = AbortSignal.timeout(limit);
    const signal = AbortSignal.any([this.controller.signal, timeout, ...(callerSignal ? [callerSignal] : [])]);
    const step: DebugStep = { id: ++this.sequence, time: new Date().toISOString(), action: command.name, input: command.input,
      status: "running", verified: command.name === "capture_ui" || command.name === "define_debug_task" ? null : false,
      message: command.name === "wait_for_ui" ? `等待 ${JSON.stringify(command.input.selector)} ${command.input.state}` : "执行中",
      ...(command.name === "define_debug_task" || command.name === "check_debug_task" ? {} : { beforeId: this.current?.entry.id }) };
    if (command.name === "tap_node" || command.name === "scroll_node" || command.name === "press_back") step.dispatchState = "not_sent";
    this.state.steps.push(step);
    this.state.steps = this.state.steps.slice(-100);
    const metadata = command.name === "define_debug_task" || command.name === "check_debug_task";
    const context: StepContext = { step, started: performance.now(),
      phase: command.name === "capture_ui" ? "capture" : command.name === "wait_for_ui" || metadata ? "verify" : "locate",
      before: metadata ? null : (command.name === "wait_for_ui" ? this.lastActionBefore ?? this.current?.entry : this.current?.entry) ?? null,
      beforeFreshness: metadata ? "current" : "previous", after: null, previousAfter: metadata ? null : this.current?.entry ?? null, invalidatedAfter: metadata };
    this.pending = context;
    this.emit();
    const run = async () => {
      let outcome: Record<string, unknown> = {};
      try {
        const result = await this.perform(command, signal, context);
        signal.throwIfAborted();
        step.status = "done";
        const description = String(result.message ?? "完成");
        step.message = description.length > 16000 ? `${description.slice(0, 15999)}…` : description;
        step.verified = typeof result.verified === "boolean" ? result.verified : null;
        step.afterId = context.after?.id;
        outcome = { ...result, stepId: step.id };
      } catch (error) {
        if (error instanceof DebugInputError) {
          step.inputEvidence = error.evidence;
          step.dispatchState = error.evidence.spawned ? "unknown" : "not_sent";
        }
        step.status = "failed";
        step.verified = false;
        step.error = failure(error, context, timeout.aborted, signal.aborted);
        step.message = timeout.aborted ? "等待超时，未验证成功；操作可能已经发出，请重新观察，不要盲目重试。" : message(error);
        step.afterId = context.after?.id;
        if (context.task) this.finishTaskCheck(context, `任务验收未完成：${step.error.message}`);
        try {
            // Retain only the latest failure per session; both snapshots carry their actual capture timestamps.
            const path = join(this.directory, "last-failure.json");
            const compatible = (entry: McpSnapshot | null) => entry ? { ...entry, snapshot: debugEvidenceSnapshot(entry.snapshot) } : null;
            writeCompatibility(path, { step, request: command, steps: this.state.steps,
              before: compatible(context.before), after: compatible(context.after),
              content: "tree-properties-without-layer-bitmaps", warning: "兼容文件不含截图或图层位图；完整屏幕证据见report.json。" });
            this.state.evidencePath = path;
          } catch (saveError) { this.recordingFailure(step, "last_failure_write_failed", saveError); }
        outcome = { isError: true, verified: false, error: step.error, stepId: step.id, message: step.message, snapshotId: this.current?.entry.id ?? null, evidencePath: this.state.evidencePath,
          ...(step.dispatchState ? { dispatchState: step.dispatchState } : {}) };
      } finally {
        this.busy = this.state.busy = false;
        this.pending = null;
        this.recordEvidence(context);
        try { writeCompatibility(join(this.directory, "steps.json"), this.state); }
        catch (error) {
          outcome.recordingWarning = `记录保存失败：${message(error)}`;
          this.recordingFailure(step, "steps_write_failed", error);
          this.recordEvidence(context);
        }
        if (step.recordingErrors?.length) {
          outcome.recordingWarning = step.recordingErrors.map(error => `记录保存失败：${error.message}`).join(" ");
          outcome.recordingErrors = step.recordingErrors;
        }
        this.emit();
      }
      if (step.taskCheck) { outcome.taskResult = structuredClone(step.taskCheck); outcome.verified = step.taskCheck.status === "passed"; }
      if (command.name === "define_debug_task" && !outcome.isError) {
        outcome.task = structuredClone(this.state.task); outcome.state = structuredClone(this.state);
      }
      return { ...outcome, message: step.message };
    };
    this.done = run();
    return this.done as Promise<Record<string, unknown>>;
  }

  private async perform(command: Exclude<DebugCommand, { name: "get_debug_session" | "stop_debug_session" }>, signal: AbortSignal, context: StepContext): Promise<Record<string, unknown>> {
    if (command.name === "check_debug_task") return this.checkTask(command.input, signal, context);
    signal.throwIfAborted();
    const { step } = context;
    if (command.name === "define_debug_task") {
      if (this.state.task) throw new Error("每个会话只能定义一个任务，已有任务定义不能修改。");
      if (this.inputRequested) throw new Error("任务必须在任何输入请求开始前定义；请重新授权新会话。");
      this.state.task = { id: randomUUID(), definedAt: step.time, definedStepId: step.id, definition: structuredClone(command.input.definition), checks: [] };
      return { task: structuredClone(this.state.task), taskId: this.state.task.id, verified: null, message: "任务条件已固定；定义任务不会采集或操作手机。" };
    }
    if (command.name === "capture_ui") {
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
      context.phase = "capture";
      const { entry } = this.accept(await this.capture(command.input.mode, signal, command.input.backend), signal, context);
      return { snapshotId: entry.id, mode: command.input.mode, source: entry.snapshot.inspectionSource ?? "unknown",
        nodeCount: entry.snapshot.nodeCount, message: "页面已更新，可搜索控件或读取截图。" };
    }
    if (command.name === "tap_node" || command.name === "scroll_node" || command.name === "press_back") {
      this.lastActionBefore = null;
      const old = this.current;
      if (!old || old.entry.id !== command.input.snapshotId) throw new Error("快照已过期，请重新采集和定位。");
      if (old.entry.snapshot.inspectionSource === "accessibility-helper") throw new Error("Helper 当前仅支持只读观察；操作前请显式采集 UIAutomator 快照并重新定位。");
      if (old.entry.snapshot.captureMode !== "fast") throw new Error("操作必须基于轻量实时快照；请先 capture_ui(mode=fast)。");
      if (Date.now() - Date.parse(old.entry.sharedAt) > 30_000) throw new Error("快照超过 30 秒，请重新采集。");
      const previous = command.name === "press_back" ? null : flattenNodes(old.entry.snapshot.root!).get(command.input.nodeId);
      if (command.name !== "press_back" && !previous) throw new Error("没有这个控件。");
      context.phase = "capture";
      const fresh = await this.capture("fast", signal);
      const current = this.accept(fresh, signal, context);
      context.phase = "locate";
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
      context.phase = "input";
      await (this.options.input ?? inputDebugApp)(this.state.serial, fresh.target, action, frame, signal,
        evidence => { step.inputEvidence = evidence; });
      step.dispatchState = "sent";
      signal.throwIfAborted();
      context.phase = "capture";
      const after = this.accept(await this.capture("fast", signal), signal, context);
      return { snapshotId: after.entry.id, dispatched: true, dispatchState: step.dispatchState, verified: false, ...metadata,
        message: `${description}并重新观察；尚未验证预期结果，请调用 wait_for_ui 或 check_debug_task。` };
    }
    if ((this.current?.entry ?? this.lastActionBefore)?.snapshot.inspectionSource === "accessibility-helper")
      throw new Error("Helper 当前不支持 wait_for_ui；请显式采集 UIAutomator 快照后再验证。");
    let confirmations = 0;
    while (true) {
      signal.throwIfAborted();
      context.phase = "capture";
      const { entry } = this.accept(await this.capture("fast", signal), signal, context);
      context.phase = "verify";
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
