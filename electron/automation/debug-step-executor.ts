import { setTimeout as delay } from "node:timers/promises";
import { matchesDebugSelector, performUiStepInput, scrollUntilInput, type DebugCommand, type PerformUiStepInput, type ResumeUiStepInput, type ScrollUntilInput } from "../../shared/debug-protocol";
import { scrollDispatchState, type DebugScrollProgress } from "../../shared/debug-scroll";
import { assertHelperBackNavigation, assertSafeHelperObservationSnapshot, assertSameHelperObservationEvidence, assertSameHelperObservationSource,
  assertSameHelperServiceEvidence, createHelperNodeRegionSafety, createHelperNodePartialVisibility, assessHelperRecoveryEvidence, helperRecoverySourceReason, isFreshHelperRecoveryEvidence, isHelperWindowMotionRecoveryEvidence, isStableHelperChildRecoveryEvidence,
  type HelperRecoveryEvidence } from "../../shared/helper-observation";
import { assessCaptureGeometry, type ScreenRect } from "../../shared/screen-coordinates";
import { flattenNodes, nodeDisplayLabel } from "../../shared/tree-utils";
import type { DebugSessionState, DebugStep, DebugStepError, FastCaptureBackend, UiNode, UiSnapshot } from "../../shared/types";
import { inputDebugApp, type DebugObserver, type DebugInputAction } from "./device-actions";
import { DebugObservationError } from "./debug-observation-error";
import { HelperCaptureError } from "../capture/accessibility-helper";
import type { HelperRecoveryDiagnostics } from "../../shared/helper-recovery-diagnostics";
import { ObservationRecoveryBudget, ObservationRecoveryTimeoutError } from "./debug-observation-recovery";
import { DebugVisualConfirmationRequired, sameInteractionEvidence, verifyVisualConfirmation } from "./debug-visual-confirmation";
import { FocusUnavailableError, sameActivityInstance } from "../device/target";
import { DebugInputError } from "../device/debug-input";
import { createHelperDebugInput } from "./helper-input";
import { debugInputMayHaveDispatched } from "../../shared/debug-input-state";
import { publishMcpSnapshot, revokeMcpSnapshot, type McpSnapshot } from "./mcp-snapshot";
import { resolveTap, resolveParentTap, resolveScroll, resolveAccessibilityScroll } from "./debug-target-resolution";
import { DebugTaskExecution } from "./debug-task-execution";
import type { DebugTaskEvidence } from "../../shared/debug-task";
import { evaluateDebugTaskConditions, partialIdentityChangedReason } from "../../shared/debug-task-checker";
import { debugStepFailure, debugStepMessage, type Current, type Observation, type StepCommand, type StepContext } from "./debug-step-context";
import { locateUiStepTarget } from "./debug-ui-step";
import type { DebugRequestRecord } from "./debug-request-ledger";
import { measureDebugPhase, withDebugObservationReason } from "./debug-timing";
import { compareScrollProgress, DebugScrollContainerMissing, inspectScrollObservation, rememberScrollObservation, type ScrollObservation } from "./debug-scroll-execution";
import { hasWindowTransitionHelperDiagnostics, hasSystemOnlyHelperFocusGapDiagnostics } from "../../shared/helper-observation-diagnostics";

/** Owns accepted observations and input intent, never authorization or the in-flight request. */
export class DebugStepExecutor {
  private current: Current | null = null;
  private lastActionBefore: McpSnapshot | null = null;
  private inputRequested = false;
  private readonly tasks: DebugTaskExecution;
  private readonly helperSources = new WeakMap<StepContext, NonNullable<UiSnapshot["helperObservation"]>>();
  private readonly scrollSources = new WeakMap<StepContext, NonNullable<UiSnapshot["helperObservation"]>>();
  private readonly helperRecoverySources = new WeakMap<StepContext, HelperRecoveryEvidence>();
  private readonly recoveryBudgets = new WeakMap<StepContext, ObservationRecoveryBudget>();

  constructor(private readonly state: DebugSessionState, private readonly options: {
    snapshotPath: string; observe: DebugObserver; input?: typeof inputDebugApp;
    getRequest?: (requestId: string) => DebugRequestRecord | undefined;
    onDispatch?: (context: StepContext, state: "unknown" | "sent") => void;
    onScrollProgress?: (context: StepContext) => void;
    onObservationSource?: (context: StepContext, snapshot: UiSnapshot) => void;
    events: { phase(context: StepContext, phase: DebugStepError["phase"]): void; emit(snapshot?: Observation["snapshot"], selectedNodeId?: string | null): void };
  }) { this.tasks = new DebugTaskExecution(state); }

  get snapshotId() { return this.current?.entry.id ?? null; }

  get planEvidence() {
    if (!this.current) return null;
    const { entry, target } = this.current;
    return structuredClone({ snapshot: entry.snapshot, observation: { snapshotId: entry.id, capturedAt: entry.sharedAt,
      component: target.component, windowId: target.windowId, activityRecordId: target.activityRecordId ?? null } });
  }

  beginStep(command: StepCommand, step: DebugStep): StepContext {
    if (command.name === "tap_node" || command.name === "scroll_node" || command.name === "press_back" || command.name === "perform_ui_step" || command.name === "scroll_until") this.inputRequested = true;
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
    if (command.name === "check_debug_task") return measureDebugPhase("verification", () => this.checkTask(command.input, signal, context));
    signal.throwIfAborted();
    switch (command.name) {
      case "define_debug_task": return Promise.resolve(this.tasks.define(command.input, context, this.inputRequested));
      case "capture_ui": return this.captureUi(command.input, signal, context);
      case "tap_node": case "scroll_node": case "press_back": return this.input(command, signal, context);
      case "perform_ui_step": return this.performUiStep(command.input, signal, context);
      case "scroll_until": return this.scrollUntil(command.input, signal, context);
      case "resume_ui_step": return this.resumeUiStep(command.input, signal, context);
      case "wait_for_ui": return measureDebugPhase("verification", () => this.waitForUi(command.input, signal, context));
      default: { const exhaustive: never = command; throw new Error(`未知调试命令：${String(exhaustive)}`); }
    }
  }

  private emit(snapshot?: Observation["snapshot"], selectedNodeId?: string | null) { this.options.events.emit(snapshot, selectedNodeId); }
  private phase(context: StepContext, phase: DebugStepError["phase"]) { this.options.events.phase(context, phase); }

  private backend(snapshot?: UiSnapshot): FastCaptureBackend {
    return snapshot?.inspectionSource === "accessibility-helper" ? "accessibility-helper" : "uiautomator";
  }

  /** Pin the Helper service across the step; normal tap/back navigation may change windows. */
  private pinObservationSource(snapshot: UiSnapshot, context: StepContext) {
    if (snapshot.captureMode !== "fast") throw new Error("操作和验证需要轻量实时快照。");
    assertSafeHelperObservationSnapshot(snapshot);
    const evidence = snapshot.helperObservation;
    const previous = this.helperSources.get(context);
    if (snapshot.inspectionSource !== "accessibility-helper") {
      if (previous) throw new Error("观察来源已变化，不能沿用旧步骤证据。");
      return;
    }
    if (previous && previous !== evidence) assertSameHelperServiceEvidence(previous, evidence!);
    if (!previous) this.options.onObservationSource?.(context, snapshot);
    this.helperSources.set(context, evidence!);
  }

  private restoreObservationSource(record: DebugRequestRecord, backend: FastCaptureBackend, context: StepContext) {
    if (backend !== "accessibility-helper") return;
    if (!record.observationSource) throw new Error("原 Helper 请求缺少来源证据，不能恢复验证；请显式重新采集。");
    this.helperSources.set(context, record.observationSource);
  }

  private acceptActionObservation(observation: Observation, signal: AbortSignal, context: StepContext): Current {
    const failed = this.helperRecoverySources.get(context);
    if (failed && (!observation.snapshot.helperObservation || !isFreshHelperRecoveryEvidence(failed, observation.snapshot.helperObservation, this.state.packageName)))
      throw new Error("恢复观察的服务、屏幕或采集时序已变化，未接受本次观察。");
    if (failed && context.step.action === "wait_for_ui"
      && !isStableHelperChildRecoveryEvidence(failed, observation.snapshot.helperObservation!, this.state.packageName))
      throw new Error("只读等待恢复期间窗口清单已变化，未接受本次观察。");
    this.pinObservationSource(observation.snapshot, context);
    this.helperRecoverySources.delete(context);
    return this.accept(observation, signal, context);
  }

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

  private async capture(mode: "fast" | "deep", signal: AbortSignal, backend: FastCaptureBackend = "uiautomator", screenshotTiming: "parallel" | "after-hierarchy" = "parallel") {
    signal.throwIfAborted();
    const observation = await this.options.observe(this.state.serial, this.state.packageName, mode, signal, backend, screenshotTiming);
    signal.throwIfAborted();
    const source = observation.snapshot.inspectionSource;
    const legacyUiAutomator = backend === "uiautomator" && source === undefined && observation.snapshot.helperObservation === undefined;
    if (mode === "fast" && source !== backend && !legacyUiAutomator)
      throw new Error("采集返回了其他来源；未沿用节点、坐标或视觉确认，请显式重新采集。");
    return observation;
  }

  private async observeAfterInput(signal: AbortSignal, context: StepContext, backend: FastCaptureBackend = "uiautomator", reason: "after_action" | "recovery" | "verification" = "after_action") {
    // Failed reads never become snapshots. All extra reads share this step's budget.
    let budget = this.recoveryBudgets.get(context);
    if (!budget) { budget = new ObservationRecoveryBudget(); this.recoveryBudgets.set(context, budget); }
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      this.phase(context, "capture");
      if (budget.remainingMs <= 0) throw new ObservationRecoveryTimeoutError();
      const recoveryTimeout = Number.isFinite(budget.remainingMs) ? AbortSignal.timeout(Math.ceil(budget.remainingMs)) : undefined;
      const readSignal = recoveryTimeout ? AbortSignal.any([signal, recoveryTimeout]) : signal;
      try {
        const observation = await withDebugObservationReason(attempt === 1 ? reason : "recovery", () => this.capture("fast", readSignal, backend));
        return { current: this.acceptActionObservation(observation, readSignal, context), attempts: attempt };
      } catch (error) {
        const cancelledRead = signal.aborted && (error === signal.reason || error instanceof Error && error.name === "AbortError");
        if (!cancelledRead && context.verification) context.verification.unrecoveredObservationFailures++;
        signal.throwIfAborted();
        if (recoveryTimeout?.aborted) throw new ObservationRecoveryTimeoutError();
        const previous = this.helperRecoverySources.get(context) ?? this.helperSources.get(context);
        const assessment = error instanceof HelperCaptureError && error.code === "helper-incomplete" && previous && error.recoveryEvidence
          ? assessHelperRecoveryEvidence(error.recoveryEvidence, this.state.packageName, previous.displayAfter) : undefined;
        const candidate = assessment?.evidence;
        const scrollSource = this.scrollSources.get(context);
        const sameScrollScope = !context.step.scrollTask || !!(candidate && scrollSource
          && candidate.windowId === scrollSource.windowId
          && [candidate.windowsBefore, candidate.windowsAfter].every(windows => windows.find(window => window.focused)?.id === scrollSource.windowId));
        const originalInput = context.step.action === "resume_ui_step"
          ? performUiStepInput.safeParse(this.options.getRequest?.(String(context.step.input.requestId))?.input) : undefined;
        const navigationAction = context.step.resolvedInput?.action.kind ?? (originalInput?.success ? originalInput.data.action.kind : undefined);
        const needsNavigation = candidate && (hasWindowTransitionHelperDiagnostics(candidate.diagnostics) || hasSystemOnlyHelperFocusGapDiagnostics(candidate.diagnostics)
          || isHelperWindowMotionRecoveryEvidence(candidate, this.state.packageName, previous!.displayAfter));
        const navigationAllowed = context.step.dispatchState === "sent" && reason !== "verification"
          && !context.step.scrollTask && (navigationAction === "tap" || navigationAction === "back");
        const source = candidate && previous ? helperRecoverySourceReason(previous, candidate, this.state.packageName) : undefined;
        const trusted = this.helperSources.get(context);
        const readOnlyChildRetry = context.step.action === "wait_for_ui" && reason === "verification"
          && context.step.dispatchState === undefined && !context.step.scrollTask && trusted
          && this.current?.entry.snapshot.helperObservation === trusted && candidate
          && isStableHelperChildRecoveryEvidence(trusted, candidate, this.state.packageName);
        const helperTransient = backend === "accessibility-helper" && candidate && previous
          && sameScrollScope
          && (context.step.dispatchState === "sent" || context.step.action === "resume_ui_step" || readOnlyChildRetry)
          && (!needsNavigation || navigationAllowed) && source === "accepted";
        const transient = helperTransient || error instanceof DebugObservationError
          || error instanceof FocusUnavailableError && error.focusReason === "null-focus";
        const willRetry = Boolean(transient && budget.reserveRetry());
        let recordedError = error;
        if (error instanceof HelperCaptureError) {
          const executor: HelperRecoveryDiagnostics["executor"] = backend !== "accessibility-helper" ? "backend_mismatch"
            : !previous ? "source_unavailable" : !candidate ? "candidate_unavailable" : !sameScrollScope ? "scroll_scope_changed"
              : context.step.dispatchState !== "sent" && context.step.action !== "resume_ui_step" && !readOnlyChildRetry ? "input_not_sent"
                : needsNavigation && !navigationAllowed ? "navigation_only" : source !== "accepted" ? "source_rejected"
                  : !willRetry ? "budget_exhausted" : "retry";
          recordedError = new HelperCaptureError(error.code, error.message, { diagnostics: error.diagnostics, recoveryEvidence: error.recoveryEvidence,
            recoveryDiagnostics: { version: 1, ...error.recoveryDiagnostics, ...assessment?.diagnostics, ...(source ? { source } : {}), executor } });
        }
        const failures = context.step.observationFailures ??= [];
        failures.push({ attempt: failures.length + 1, elapsedMs: performance.now() - context.started, willRetry,
          error: debugStepFailure(recordedError, context, false, false) });
        if (!willRetry) throw recordedError;
        if (helperTransient) this.helperRecoverySources.set(context, candidate!);
        context.step.message = `观察暂未就绪；正在重新观察（${attempt + 1}/3）。`;
        this.emit();
        await measureDebugPhase("recovery", () => this.waitForObservation(250, signal, context));
      }
    }
  }

  private async waitForObservation(ms: number, signal: AbortSignal, context: StepContext) {
    signal.throwIfAborted();
    const remaining = this.recoveryBudgets.get(context)?.remainingMs ?? Infinity;
    if (remaining <= 0) throw new ObservationRecoveryTimeoutError();
    const timeout = Number.isFinite(remaining) ? AbortSignal.timeout(Math.ceil(remaining)) : undefined;
    try { await delay(ms, undefined, { signal: timeout ? AbortSignal.any([signal, timeout]) : signal }); }
    catch (error) { signal.throwIfAborted(); if (timeout?.aborted) throw new ObservationRecoveryTimeoutError(); throw error; }
  }

  private async checkTask(input: Extract<DebugCommand, { name: "check_debug_task" }>["input"], signal: AbortSignal,
    context: StepContext): Promise<Record<string, unknown>> {
    const immediate = this.tasks.beginCheck(input, signal, context);
    if (immediate) return immediate;
    const previous = (this.current?.entry ?? this.lastActionBefore)?.snapshot;
    const backend = this.backend(previous);
    if (backend === "accessibility-helper") this.pinObservationSource(previous!, context);
    this.phase(context, "capture");
    const first = this.acceptActionObservation(await withDebugObservationReason("verification", () => this.capture("fast", signal, backend)), signal, context);
    this.phase(context, "verify");
    await delay(350, undefined, { signal });
    this.phase(context, "capture");
    const second = this.acceptActionObservation(await withDebugObservationReason("verification", () => this.capture("fast", signal, backend)), signal, context);
    assertSameHelperObservationSource(first.entry.snapshot, second.entry.snapshot);
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
    const { entry } = this.accept(await withDebugObservationReason("explicit", () => this.capture(input.mode, signal, input.backend)), signal, context);
    return { snapshotId: entry.id, mode: input.mode, source: entry.snapshot.inspectionSource ?? "unknown",
      nodeCount: entry.snapshot.nodeCount, captureDurationMs: entry.snapshot.captureDurationMs,
      message: "页面已更新，可直接查询此快照，无需重复采集。" };
  }

  private async input(command: Extract<StepCommand, { name: "tap_node" | "scroll_node" | "press_back" }>, signal: AbortSignal, context: StepContext,
    prepared?: { old: Current; current: Current; anchorNodeId?: string; scrollInputMethod?: "gesture" | "accessibility" }) {
    const { step } = context;
    this.lastActionBefore = null;
    const old = prepared?.old ?? this.current;
    if (!old || old.entry.id !== command.input.snapshotId) throw new Error("快照已过期，请重新采集和定位。");
    assertSafeHelperObservationSnapshot(old.entry.snapshot);
    if (old.entry.snapshot.captureMode !== "fast") throw new Error("操作必须基于轻量实时快照；请先 capture_ui(mode=fast)。");
    if (Date.now() - Date.parse(old.entry.sharedAt) > 30_000) throw new Error("快照超过 30 秒，请重新采集。");
    const previous = command.name === "press_back" ? null : flattenNodes(old.entry.snapshot.root!).get(command.input.nodeId);
    if (command.name !== "press_back" && !previous) throw new Error("没有这个控件。");
    this.phase(context, "capture");
    const backend = this.backend(old.entry.snapshot);
    const current = prepared?.current ?? this.acceptActionObservation(await withDebugObservationReason("before_action", () => this.capture("fast", signal, backend,
      command.name !== "press_back" && command.input.visualConfirmation ? "after-hierarchy" : "parallel")), signal, context);
    if (old.entry !== current.entry) assertSameHelperObservationSource(old.entry.snapshot, current.entry.snapshot);
    this.pinObservationSource(current.entry.snapshot, context);
    const fresh = { snapshot: current.entry.snapshot, target: current.target };
    // accept attaches the observed window to this snapshot. Use the same normalized
    // evidence on both sides of preflight, including inherited window identities.
    const currentSnapshot = current.entry.snapshot;
    this.phase(context, "locate");
    const { action, frame, targetNodeId, anchorNodeId, scrollRegion, visualConfirmation, metadata, description } = await measureDebugPhase("validation", async () => {
    if (old.target.windowId !== fresh.target.windowId || !sameActivityInstance(old.target, fresh.target)) throw new Error("窗口已变化，未执行操作。");
    const frame = fresh.snapshot.captureGeometry?.afterScreenshot, oldFrame = old.entry.snapshot.captureGeometry?.afterScreenshot;
    if (assessCaptureGeometry(fresh.snapshot.captureGeometry).status !== "checked" || !frame || !oldFrame
      || frame.width !== oldFrame.width || frame.height !== oldFrame.height || frame.rotation !== oldFrame.rotation) throw new Error("屏幕方向或尺寸变化，未执行操作。");
    let action: DebugInputAction = { kind: "back" };
    if (command.name === "press_back") {
      assertHelperBackNavigation(old.entry.snapshot);
      assertHelperBackNavigation(currentSnapshot);
    }
    let targetNodeId: string | undefined, anchorNodeId: string | undefined;
    let visualConfirmation: NonNullable<DebugStep["resolvedInput"]>["visualConfirmation"];
    let scrollRegion: NonNullable<DebugStep["resolvedInput"]>["scrollRegion"];
    const confirmOverlaps = async (node: UiNode, overlaps: UiNode[], reference: UiNode, beforeOverlaps: UiNode[],
      scrollBounds?: { before: ScreenRect; after: ScreenRect }) => {
      if (command.name === "press_back") return;
      if (!command.input.visualConfirmation) {
        if (overlaps.length) throw new DebugVisualConfirmationRequired(current.entry.id,
          anchorNodeId ?? node.id, command.name === "tap_node" ? command.input.target ?? "self" : "self", node, overlaps);
        return;
      }
      visualConfirmation = await verifyVisualConfirmation({ before: old.entry.snapshot, after: currentSnapshot,
        beforeBounds: scrollBounds?.before ?? reference.bounds!, afterBounds: scrollBounds?.after ?? node.bounds!,
        action: scrollBounds ? "scroll" : "tap", referenceSnapshotId: old.entry.id, currentSnapshotId: current.entry.id,
        description: command.input.visualConfirmation.description, overlaps, beforeOverlaps, signal });
    };
    let metadata: Record<string, unknown> = {};
    let description = "已发送返回键";
    if (command.name === "tap_node") {
      const parent = command.input.target === "clickable-parent"
        ? resolveParentTap(previous!, old.entry.snapshot, currentSnapshot, this.state.packageName, "report") : null;
      const resolved = parent ?? resolveTap(previous!, currentSnapshot, this.state.packageName, old.entry.snapshot, "report");
      const { node, x, y } = resolved;
      if (prepared?.anchorNodeId && (parent?.anchor.id ?? node.id) !== prepared.anchorNodeId)
        throw new Error("新定位目标与原视觉确认目标不一致，未执行操作。");
      action = { kind: "tap", x, y };
      targetNodeId = node.id; anchorNodeId = parent?.anchor.id ?? node.id;
      const reference = command.input.visualConfirmation
        ? (parent ? resolveParentTap(previous!, old.entry.snapshot, old.entry.snapshot, this.state.packageName, "report")
          : resolveTap(previous!, old.entry.snapshot, this.state.packageName, old.entry.snapshot, "report")) : null;
      await confirmOverlaps(node, resolved.overlaps, reference?.node ?? previous!, reference?.overlaps ?? []);
      const label = command.input.target === "clickable-parent" ? `${nodeDisplayLabel(previous!)}的父控件` : nodeDisplayLabel(node);
      metadata = { target: label, targetNodeId: node.id, anchorNodeId, x, y };
      description = `已点击 ${label} (${x}, ${y})`;
      this.emit(fresh.snapshot, node.id);
    } else if (command.name === "scroll_node") {
      const resolved = resolveScroll(previous!, currentSnapshot, this.state.packageName, command.input, "report");
      if (prepared?.anchorNodeId && resolved.node.id !== prepared.anchorNodeId)
        throw new Error("新定位滚动区域与原视觉确认目标不一致，未执行操作。");
      action = resolved.action;
      if (prepared?.scrollInputMethod === "accessibility") {
        if (backend !== "accessibility-helper") throw new Error("无障碍滚动必须显式使用 Helper。");
        resolveAccessibilityScroll(previous!, command.input.direction);
        action = resolveAccessibilityScroll(resolved.node, command.input.direction);
      }
      targetNodeId = resolved.node.id;
      const reference = resolveScroll(previous!, old.entry.snapshot, this.state.packageName, command.input, "report");
      if (JSON.stringify(reference.geometry) !== JSON.stringify(resolved.geometry))
        throw new Error("滚动有效区域或底栏结构已变化，请查看新截图并重新定位，未滑动。");
      if (!sameInteractionEvidence(reference.pathControls, old.entry.snapshot, resolved.pathControls, currentSnapshot))
        throw new Error("滑动通道内的可操作控件已变化，请查看新截图并重新定位，未滑动。");
      await confirmOverlaps(resolved.node, resolved.overlaps, previous!, reference.overlaps,
        { before: reference.confirmationBounds, after: resolved.confirmationBounds });
      scrollRegion = { viewport: resolved.geometry.viewport, confirmationBounds: resolved.confirmationBounds,
        excludedNavigationBounds: resolved.geometry.excludedNavigation.map(item => item.bounds) };
      metadata = { target: nodeDisplayLabel(resolved.node), direction: command.input.direction, gesture: action, scrollRegion };
      description = `已滚动 ${nodeDisplayLabel(resolved.node)}`;
      this.emit(fresh.snapshot, resolved.node.id);
    }
    return { action, frame, targetNodeId, anchorNodeId, scrollRegion, visualConfirmation, metadata, description };
    });
    this.lastActionBefore = current.entry;
    context.before = current.entry;
    context.beforeFreshness = "current";
    step.beforeId = current.entry.id;
    // Preserve the resolved input even if its receipt or the following observation fails.
    step.resolvedInput = { action: { ...action }, frame: { ...frame },
      ...(targetNodeId ? { targetNodeId } : {}), ...(anchorNodeId ? { anchorNodeId } : {}),
      ...(scrollRegion ? { scrollRegion } : {}),
      ...(visualConfirmation ? { visualConfirmation } : {}) };
    signal.throwIfAborted();
    // A sent/uncertain input invalidates its snapshot, including after client cancellation.
    this.current = null;
    context.after = null;
    context.invalidatedAfter = true;
    revokeMcpSnapshot(this.options.snapshotPath);
    // Persist uncertainty before dispatch. A journal failure must prevent input.
    if ((this.recoveryBudgets.get(context)?.remainingMs ?? Infinity) <= 0) throw new ObservationRecoveryTimeoutError();
    if (step.scrollTask) {
      const iteration = step.scrollTask.iterations.at(-1)!;
      iteration.resolvedInput = structuredClone(step.resolvedInput);
      this.options.onScrollProgress?.(context);
    }
    this.options.onDispatch?.(context, "unknown");
    step.dispatchState = step.scrollTask ? scrollDispatchState(step.scrollTask) : "unknown";
    this.phase(context, "input");
    const onEvidence = (evidence: NonNullable<DebugStep["inputEvidence"]>) => {
      step.inputEvidence = evidence;
      if (step.scrollTask) step.scrollTask.iterations.at(-1)!.inputEvidence = structuredClone(evidence);
    };
    await measureDebugPhase("input", () => backend === "accessibility-helper" && !this.options.input
      ? (this.options.observe.helperInput ?? createHelperDebugInput())(this.state.serial, fresh.target, action, frame,
        fresh.snapshot.helperObservation, signal, onEvidence, targetNodeId ? flattenNodes(fresh.snapshot.root!).get(targetNodeId) : undefined)
      : (this.options.input ?? inputDebugApp)(this.state.serial, fresh.target, action, frame, signal, onEvidence));
    if (!step.scrollTask) step.dispatchState = "sent";
    this.options.onDispatch?.(context, "sent");
    step.dispatchState = step.scrollTask ? scrollDispatchState(step.scrollTask) : "sent";
    signal.throwIfAborted();
    const { current: after, attempts } = await this.observeAfterInput(signal, context, backend);
    const recovery = attempts > 1 ? `（页面切换后第 ${attempts} 次观察恢复）` : "";
    return { snapshotId: after.entry.id, dispatched: true, dispatchState: step.dispatchState, verified: false, ...metadata,
      ...(visualConfirmation ? { visualConfirmation } : {}),
      observationAttempts: attempts,
      message: `${description}并重新观察${recovery}；尚未验证预期结果，请调用 wait_for_ui 或 check_debug_task。` };
  }

  private async performUiStep(input: PerformUiStepInput, signal: AbortSignal, context: StepContext) {
    if (input.expect?.visibility === "partial" && input.backend !== "accessibility-helper")
      throw new Error("partial 只读断言需要明确的 Helper 来源，未执行输入。");
    const reference = input.visualConfirmation ? this.current : null;
    if (input.visualConfirmation && (!reference || reference.entry.id !== input.visualConfirmation.snapshotId
      || Date.now() - Date.parse(reference.entry.sharedAt) > 30_000)) throw new Error("视觉确认快照已过期，请查看新截图后重新确认。");
    this.phase(context, "capture");
    if (reference && this.backend(reference.entry.snapshot) !== input.backend)
      throw new Error("视觉确认不能跨采集来源使用，请重新采集和定位。");
    const current = this.acceptActionObservation(await withDebugObservationReason("before_action", () => this.capture("fast", signal, input.backend,
      input.visualConfirmation ? "after-hierarchy" : "parallel")), signal, context);
    if (current.entry.snapshot.inspectionSource !== input.backend) throw new Error("复合操作需要明确的实时观察来源。");
    this.phase(context, "locate");
    const old = reference ?? current;
    let freshNodeId: string | undefined;
    const node = input.target ? await measureDebugPhase("relocation", async () => {
      const freshNode = locateUiStepTarget(current, input.target!, this.state.packageName);
      freshNodeId = freshNode.id;
      if (!reference) return freshNode;
      const previous = locateUiStepTarget(reference, input.target!, this.state.packageName);
      // Existing preflight rechecks identity, geometry, relationship and pixels.
      // Both observations must also have a unique match for the requested selector.
      return previous;
    }) : null;
    const base = { sessionId: input.sessionId, snapshotId: old.entry.id };
    const visual = input.visualConfirmation ? { visualConfirmation: { description: input.visualConfirmation.description } } : {};
    const command: Extract<StepCommand, { name: "tap_node" | "scroll_node" | "press_back" }> = input.action.kind === "back"
      ? { name: "press_back", input: base }
      : input.action.kind === "tap" ? { name: "tap_node", input: { ...base, nodeId: node!.id, target: input.target!.target, ...visual } }
      : { name: "scroll_node", input: { ...base, nodeId: node!.id, direction: input.action.direction,
        distance: input.action.distance, durationMs: input.action.durationMs, ...visual } };
    const result = await this.input(command, signal, context, { old, current, anchorNodeId: freshNodeId });
    if (!input.expect) return result;
    return { ...result, ...await measureDebugPhase("verification", () => this.waitForUi({ sessionId: input.sessionId,
      ...input.expect!, timeoutMs: input.timeoutMs }, signal, context, this.current)) };
  }

  private async resumeUiStep(input: ResumeUiStepInput, signal: AbortSignal, context: StepContext) {
    const record = this.options.getRequest?.(input.requestId);
    const scroll = scrollUntilInput.safeParse(record?.input);
    if (record && scroll.success) {
      this.restoreObservationSource(record, scroll.data.backend, context);
      if (record.observationSource) this.scrollSources.set(context, record.observationSource);
      context.step.scrollTask = structuredClone(record.progress ?? { stopReason: "running", iterations: [], observationIds: [] });
      context.step.dispatchState = record.dispatchState;
      return this.scrollUntil(scroll.data, signal, context, true);
    }
    if (!record || record.dispatchState === "not_sent") throw new Error("该请求没有已发送或可能发送的输入，无需恢复观察。");
    const original = performUiStepInput.parse(record.input);
    this.restoreObservationSource(record, original.backend, context);
    context.step.dispatchState = record.dispatchState;
    const { current, attempts } = await this.observeAfterInput(signal, context, original.backend, "recovery");
    const result = original.expect ? await measureDebugPhase("verification", () => this.waitForUi({ sessionId: input.sessionId,
      ...original.expect!, timeoutMs: input.timeoutMs }, signal, context, current))
      : { snapshotId: current.entry.id, verified: false, message: "已恢复当前观察；原请求未指定预期条件，未声明验证成功。" };
    return { ...result, dispatchState: record.dispatchState, observationAttempts: attempts, resumed: true };
  }

  private scrollObservation(current: Current, input: ScrollUntilInput, context: StepContext, resume: boolean): ScrollObservation {
    const progress = context.step.scrollTask!;
    rememberScrollObservation(progress, current.entry.id);
    const snapshots = [...context.scrollObservations ?? [], current.entry];
    const keep = new Set([...progress.iterations.flatMap(item => [item.beforeId, item.afterId]),
      progress.confirmation?.firstSnapshotId, progress.confirmation?.secondSnapshotId, ...snapshots.slice(-2).map(item => item.id)]);
    context.scrollObservations = snapshots.filter((entry, index) => keep.has(entry.id) && snapshots.findIndex(item => item.id === entry.id) === index);
    this.pinObservationSource(current.entry.snapshot, context);
    if (current.entry.snapshot.inspectionSource !== input.backend) throw new Error("连续滚动需要明确的实时观察来源。");
    const helper = current.entry.snapshot.helperObservation, previousHelper = this.scrollSources.get(context);
    if (helper) {
      if (previousHelper && previousHelper !== helper) assertSameHelperObservationEvidence(previousHelper, helper);
      this.scrollSources.set(context, helper);
    }
    const frame = current.entry.snapshot.captureGeometry?.afterScreenshot;
    if (!frame || assessCaptureGeometry(current.entry.snapshot.captureGeometry).status !== "checked")
      throw new Error("屏幕几何信息未确认，停止连续滚动。");
    if (!progress.scope) {
      if (resume && context.step.dispatchState !== "not_sent") throw new Error("原请求缺少窗口证据，不能恢复验证。");
      progress.scope = { windowId: current.target.windowId, component: current.target.component,
        ...(current.target.activityRecordId ? { activityRecordId: current.target.activityRecordId } : {}), frame: { ...frame } };
    }
    const scope = progress.scope;
    if (scope.windowId !== current.target.windowId || scope.component !== current.target.component
      || scope.activityRecordId !== current.target.activityRecordId || scope.frame.width !== frame.width
      || scope.frame.height !== frame.height || scope.frame.rotation !== frame.rotation)
      throw new Error("滚动期间窗口、Activity 或屏幕尺寸已变化，已停止。");
    this.options.onScrollProgress?.(context);
    return inspectScrollObservation(current, input, this.state.packageName);
  }

  /** One bounded task owns all gestures. Recovery enters the same loop in read-only mode. */
  private async scrollUntil(input: ScrollUntilInput, signal: AbortSignal, context: StepContext, resume = false): Promise<Record<string, unknown>> {
    const progress: DebugScrollProgress = context.step.scrollTask ??= { stopReason: "running", iterations: [], observationIds: [] };
    progress.stopReason = "running";
    delete progress.confirmation;
    const reference = !resume && input.visualConfirmation ? this.current : null;
    let revealTargetKey: string | undefined;
    const checkRevealTarget = (observed: ScrollObservation) => {
      if (observed.revealTargetKey) {
        if (revealTargetKey && revealTargetKey !== observed.revealTargetKey) throw new Error("继续查找期间目标身份发生变化，已停止滚动。");
        revealTargetKey = observed.revealTargetKey;
      }
      return observed;
    };
    let unchanged = 0, unknownProgress = 0;
    const result = (reason: DebugScrollProgress["stopReason"], message: string, verified = false) => {
      progress.stopReason = reason;
      if (!resume) context.step.dispatchState = scrollDispatchState(progress);
      this.options.onScrollProgress?.(context);
      return { snapshotId: this.current?.entry.id, dispatchState: context.step.dispatchState, verified,
        scrollTask: structuredClone(progress), ...(resume ? { resumed: true } : {}), message };
    };
    const nextObservation = async () => {
      await this.waitForObservation(350, signal, context);
      const { current, attempts } = await this.observeAfterInput(signal, context, input.backend, "verification");
      return { ...checkRevealTarget(this.scrollObservation(current, input, context, resume)), recovered: attempts > 1 };
    };
    try {
      if (!resume && input.visualConfirmation && (!reference || reference.entry.id !== input.visualConfirmation.snapshotId
        || Date.now() - Date.parse(reference.entry.sharedAt) > 30_000)) throw new Error("视觉确认快照已过期，请查看新截图后重新确认。");
      this.phase(context, "capture");
      if (reference && this.backend(reference.entry.snapshot) !== input.backend)
        throw new Error("视觉确认不能跨采集来源使用，请重新采集和定位。");
      const current = resume ? (await this.observeAfterInput(signal, context, input.backend, "recovery")).current
        : this.acceptActionObservation(await withDebugObservationReason("before_action", () => this.capture("fast", signal, input.backend,
          reference ? "after-hierarchy" : "parallel")), signal, context);
      let observed = checkRevealTarget(this.scrollObservation(current, input, context, resume));
      context.before = current.entry; context.beforeFreshness = "current"; context.step.beforeId = current.entry.id;
      while (true) {
        signal.throwIfAborted();
        this.phase(context, "verify");
        if (observed.loading) { unchanged = 0; unknownProgress = 0; observed = await nextObservation(); continue; }
        if (observed.condition) {
          const first = observed;
          const confirmation = await measureDebugPhase("verification", nextObservation);
          observed = confirmation;
          if (confirmation.recovered) continue;
          if (observed.conditionKey === first.conditionKey && observed.current.entry.id !== first.current.entry.id) {
            progress.confirmation = { firstSnapshotId: first.current.entry.id, secondSnapshotId: observed.current.entry.id, kind: observed.condition! };
            this.lastActionBefore = null;
            return observed.condition === "empty" ? result("empty", "连续两次确认列表为空，未找到请求目标。")
              : result(observed.condition === "end_marker" ? "end_reached" : "target_found", "连续两次新观察确认滚动条件。", true);
          }
          continue;
        }
        if (resume) { observed = await nextObservation(); continue; }
        if (unknownProgress >= 2) return result("interrupted", "连续两次输入后仍缺少可靠滚动进展证据；已停止，未确认目标或终点。");
        if (unchanged >= 2) return result("no_progress", "连续两次滚动未发现可靠内容变化；未声明已经到底。");
        if (progress.iterations.length >= input.maxScrolls) return result("scroll_limit", "已达到本次滚动次数上限，未验证目标或终点。");
        const iteration = { index: progress.iterations.length + 1, startedAt: new Date().toISOString(), durationMs: 0,
          beforeId: observed.current.entry.id, dispatchState: "not_sent" as const, progress: "unknown" as const };
        progress.iterations.push(iteration);
        delete context.step.resolvedInput; delete context.step.inputEvidence;
        const started = performance.now(), before = observed;
        try {
          this.options.onScrollProgress?.(context);
          const old = progress.iterations.length === 1 && reference ? reference : observed.current;
          const node = old === observed.current ? observed.container
            : locateUiStepTarget(old, { ...input.target, target: "self", scrollable: true }, this.state.packageName);
          const visual = progress.iterations.length === 1 && input.visualConfirmation
            ? { visualConfirmation: { description: input.visualConfirmation.description } } : {};
          await this.input({ name: "scroll_node", input: { sessionId: input.sessionId, snapshotId: old.entry.id,
            nodeId: node.id, direction: input.direction, distance: input.distance, durationMs: input.durationMs, ...visual } }, signal, context,
            { old, current: observed.current, anchorNodeId: observed.container.id, scrollInputMethod: input.inputMethod });
          const latest = progress.iterations.at(-1)!;
          latest.afterId = this.current!.entry.id;
          observed = checkRevealTarget(this.scrollObservation(this.current!, input, context, false));
          latest.progress = compareScrollProgress(before, observed, input.direction);
          unchanged = latest.progress === "unchanged" ? unchanged + 1 : 0;
          unknownProgress = input.backend === "accessibility-helper" && latest.dispatchState === "sent" && latest.progress === "unknown"
            ? unknownProgress + 1 : 0;
        } catch (error) {
          const latest = progress.iterations.at(-1)!;
          latest.error = debugStepMessage(error);
          if (error instanceof DebugInputError && !latest.inputEvidence) latest.inputEvidence = structuredClone(error.evidence);
          if (error instanceof DebugInputError) latest.dispatchState = debugInputMayHaveDispatched(error.evidence) ? "unknown" : "not_sent";
          throw error;
        } finally {
          const latest = progress.iterations.at(-1)!;
          latest.durationMs = Math.max(0, performance.now() - started);
          context.step.dispatchState = scrollDispatchState(progress);
          try { this.options.onScrollProgress?.(context); }
          finally { delete context.step.resolvedInput; delete context.step.inputEvidence; }
        }
      }
    } catch (error) {
      if (progress.stopReason === "running") progress.stopReason = error instanceof DebugScrollContainerMissing ? "container_missing" : "interrupted";
      if (!resume) context.step.dispatchState = scrollDispatchState(progress);
      throw error;
    }
  }

  private async waitForUi(input: Extract<DebugCommand, { name: "wait_for_ui" }>["input"], signal: AbortSignal, context: StepContext, initial: Current | null = null) {
    const previous = initial?.entry.snapshot ?? (this.current?.entry ?? this.lastActionBefore)?.snapshot;
    const backend = this.backend(previous);
    const partial = input.visibility === "partial";
    if (partial && backend !== "accessibility-helper") throw new Error("partial 只读断言需要 Helper 完整双帧证据。");
    if (backend === "accessibility-helper") this.pinObservationSource(previous!, context);
    let confirmations = 0;
    let confirmationSnapshot: UiSnapshot | null = null;
    let strictPrevious: DebugTaskEvidence | null = null;
    let strictPreviousEntry: McpSnapshot | null = null;
    let strictPreviousMet: boolean | null = null;
    let identityRestarted = false;
    const verification = context.verification = { completedObservations: 0, lastVisibleMatchCount: null as number | null,
      matchedObservations: 0, consecutiveMatches: 0, unrecoveredObservationFailures: 0 };
    while (true) {
      signal.throwIfAborted();
      this.phase(context, "capture");
      const observed = initial ? { current: initial, attempts: 1 } : await this.observeAfterInput(signal, context, backend, "verification");
      if (observed.attempts > 1) { confirmations = 0; confirmationSnapshot = null; strictPrevious = null; strictPreviousEntry = null; strictPreviousMet = null; }
      const { entry } = observed.current;
      initial = null;
      this.phase(context, "verify");
      // A read only counts after identity, visibility and region checks finish; failures need a new complete read.
      verification.unrecoveredObservationFailures = Math.max(1, verification.unrecoveredObservationFailures);
      const candidates = [...flattenNodes(entry.snapshot.root!).values()].filter(node => node.package === this.state.packageName && matchesDebugSelector(node, input.selector));
      const matches = candidates.filter(node => node.visibleToUser && node.visibilityEvidence !== "hidden");
      const exposure = partial ? candidates.map(createHelperNodePartialVisibility(entry.snapshot)) : [];
      if (partial && (candidates.length > 1 || exposure.some(result => result.status === "unknown")))
        throw new Error("partial 断言缺少唯一目标或明确的可见区域证据。");
      if (!partial) {
        const regionSafety = createHelperNodeRegionSafety(entry.snapshot);
        if (candidates.some(node => regionSafety(node) !== "clear"))
          throw new Error("预期控件区域被遮挡或缺少有效位置，不能确认状态，也不能据此证明控件不存在。");
      }
      const { state } = input;
      const met = partial ? matches.length === 1 && exposure[0]?.status === "exposed"
        : state === "absent" ? matches.length === 0 : state === "visible" ? matches.length > 0
        : matches.length > 0 && matches.every(node => node.enabled === (state === "enabled"));
      let strictPassed = false;
      if (context.strictConditions || partial) {
        const currentEvidence = this.planEvidence;
        // A changing condition needs another observation; stable evidence must also be unique and complete.
        if (strictPrevious && strictPreviousMet === met) {
          const assessment = evaluateDebugTaskConditions([{ id: "plan_expectation", selector: input.selector, state, visibility: input.visibility }],
            strictPrevious, currentEvidence, this.state.packageName);
          if (assessment.status === "insufficient_evidence") {
            if (!partial || identityRestarted || assessment.conditions[0]?.reason !== partialIdentityChangedReason)
              throw new Error(`计划条件证据不足：${assessment.reason}`);
            // Discard the mismatched pair; one restart still needs two new stable frames within this step's deadline.
            identityRestarted = true;
            confirmations = 0; confirmationSnapshot = null; strictPrevious = null; strictPreviousEntry = null; strictPreviousMet = null;
            verification.completedObservations++; verification.lastVisibleMatchCount = matches.length;
            verification.matchedObservations += Number(met); verification.consecutiveMatches = 0; verification.unrecoveredObservationFailures = 0;
            await this.waitForObservation(350, signal, context);
            continue;
          }
          strictPassed = assessment.status === "passed";
          if (partial && strictPassed) {
            if (!strictPreviousEntry || !currentEvidence || Date.parse(strictPrevious.observation.capturedAt) < Date.parse(context.step.time))
              throw new Error("partial 的双帧确认必须来自本次步骤的新观察。");
            context.step.assertionConfirmation = { first: structuredClone(strictPrevious.observation), second: structuredClone(currentEvidence.observation) };
            context.assertionObservations = [strictPreviousEntry, entry];
          }
        }
        strictPrevious = currentEvidence;
        strictPreviousEntry = entry;
        strictPreviousMet = met;
      }
      if (met && confirmationSnapshot) assertSameHelperObservationSource(confirmationSnapshot, entry.snapshot);
      confirmationSnapshot = met ? entry.snapshot : null;
      confirmations = met ? confirmations + 1 : 0;
      verification.completedObservations++;
      verification.lastVisibleMatchCount = matches.length;
      verification.matchedObservations += Number(met);
      verification.consecutiveMatches = confirmations;
      verification.unrecoveredObservationFailures = 0;
      if (context.strictConditions || partial ? strictPassed : confirmations >= 2) {
        this.lastActionBefore = null;
        if (matches[0]) this.emit(entry.snapshot, matches[0].id);
        return { verified: true, snapshotId: entry.id, matchCount: matches.length, message: "连续两次观察符合预期。" };
      }
      if (!met && backend === "accessibility-helper" && this.options.observe.waitForCondition) {
        let ready = false;
        while (true) {
          signal.throwIfAborted();
          this.phase(context, "verify");
          const remaining = this.recoveryBudgets.get(context)?.remainingMs ?? Infinity;
          if (remaining <= 0) throw new ObservationRecoveryTimeoutError();
          const timeout = Number.isFinite(remaining) ? AbortSignal.timeout(Math.ceil(remaining)) : undefined;
          let hint;
          try {
            hint = await this.options.observe.waitForCondition(this.state.serial, this.state.packageName,
              { selector: input.selector, state: input.state }, timeout ? AbortSignal.any([signal, timeout]) : signal);
          } catch (error) { signal.throwIfAborted(); if (timeout?.aborted) throw new ObservationRecoveryTimeoutError(); throw error; }
          if (!hint) break; // An older Helper retains the same complete-observation path.
          if (hint.status === "ready") { ready = true; break; }
        }
        // Hints never become evidence. Require two new complete frames after device readiness.
        confirmations = 0; confirmationSnapshot = null; strictPrevious = null; strictPreviousEntry = null; strictPreviousMet = null;
        if (ready) { context.strictConditions = true; continue; }
      }
      await this.waitForObservation(350, signal, context);
    }
  }
}
