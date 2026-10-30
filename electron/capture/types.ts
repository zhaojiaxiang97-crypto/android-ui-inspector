import type { UiNode, UiSnapshot } from "../../shared/types";
import type { InspectionMode } from "../../shared/inspection-mode";

export type CheckedSdkTreeIdentity = { serial: string; packageName: string; pid: number; component: string; windowId: string };
export type InspectionOptions = { inspectionMode?: InspectionMode; signal?: AbortSignal; onProgress?: (stage: string, elapsedMs: number) => void; onPreview?: (phase: "tree" | "layers" | "screen", snapshot: UiSnapshot) => void; onViewTreeReady?: (packageName: string, root: UiNode, mode?: "adopt", prefetched?: unknown, checkedIdentity?: CheckedSdkTreeIdentity) => Promise<void>; expectedPackage?: string; pinFirstComponent?: string | null; startupRetry?: boolean; singleAttempt?: boolean; allowAppRestart?: boolean; preferVisibleSdk?: boolean; priorityViewRef?: string; layerPreviewPolling?: boolean };

export type InspectionPreview = ((phase: "tree" | "layers") => void | Promise<void>) & { beginTreeScreen?: () => Promise<void> };
