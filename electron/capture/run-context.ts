import type { InspectionOptions } from "./types";
import { withCommandSignal } from "../device/command-context";
import { CapturePlan } from "./capture-plan";

type TreeReadyArguments = Parameters<NonNullable<InspectionOptions["onViewTreeReady"]>>;

export type CaptureRunContext = {
  readonly signal?: AbortSignal;
  readonly options: Readonly<Omit<InspectionOptions, "signal" | "pinFirstComponent">>;
  readonly request: { pinFirstComponent?: string | null };
  readonly plan: CapturePlan;
  readonly treeVerifier?: (stageContext: CaptureRunContext, ...args: TreeReadyArguments) => Promise<void>;
};

export function createCaptureRunContext(options: InspectionOptions = {}): CaptureRunContext {
  const { signal, pinFirstComponent, ...policy } = options;
  return { signal, options: policy, request: { pinFirstComponent },
    plan: new CapturePlan(options.preferVisibleSdk, options.startupRetry) };
}

// A retry retains the authorized first component but chooses its own image route.
export function createCaptureAttemptContext(context: CaptureRunContext, overrides: {
  signal?: AbortSignal;
  startupRetry?: boolean;
} = {}): CaptureRunContext {
  return { signal: overrides.signal ?? context.signal, options: { ...context.options }, request: context.request,
    plan: new CapturePlan(context.options.preferVisibleSdk, overrides.startupRetry ?? context.plan.startupRetry),
    treeVerifier: context.treeVerifier };
}

// Stage deadlines share this attempt's route decisions and request identity.
export function withCaptureSignal(context: CaptureRunContext, signal: AbortSignal | undefined): CaptureRunContext {
  return { ...context, signal };
}

// Internal verification must receive the active stage deadline, not a request's
// longer-lived signal captured when the callback was installed.
export function notifyViewTreeReady(context: CaptureRunContext, ...args: TreeReadyArguments): Promise<void> {
  return withCommandSignal(context.signal, async () => {
    if (context.treeVerifier) await context.treeVerifier(context, ...args);
    else await context.options.onViewTreeReady?.(...args);
  });
}
