import type { UiNode } from "../../shared/types";
import type { InspectionMode } from "../../shared/inspection-mode";
import type { CheckedSdkTreeIdentity } from "./types";
import { sdkTreePhase } from "../sdk/sdk-tree-read";

export type VerifiedSdkTree = { packageName: string; pid: number; component: string; windowId: string; tree: unknown };
export type SdkTreeVerificationRequest = { serial: string; packageName: string; root: UiNode; prefetched?: unknown; checkedIdentity?: CheckedSdkTreeIdentity; signal?: AbortSignal; inspectionMode?: InspectionMode };
export type SdkTreeVerificationPorts = {
  installed(): Promise<boolean>;
  target(): Promise<{ component: string; windowId: string }>;
  pid(): Promise<number>;
  read(): Promise<unknown>;
};

/** Validate an in-call proof or bracket a standalone tree read with identity checks. */
export async function verifySdkTreeIdentity(request: SdkTreeVerificationRequest, ports: SdkTreeVerificationPorts): Promise<VerifiedSdkTree | null> {
  const { serial, packageName, root, prefetched, checkedIdentity, signal } = request;
  signal?.throwIfAborted();
  if (request.inspectionMode !== "sdk-enhanced") return null;
  if (prefetched !== undefined) {
    const pid = Number(root.attributes?.["debug-process-id"]);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("SDK 与独立画面主进程不一致");
    let confirmed: { component: string; windowId: string };
    if (checkedIdentity) {
      if (checkedIdentity.serial !== serial || checkedIdentity.packageName !== packageName || checkedIdentity.pid !== pid
        || !checkedIdentity.windowId || checkedIdentity.component !== root.attributes?.["debug-component"]) throw new Error("进程或窗口已变化");
      signal?.throwIfAborted(); confirmed = checkedIdentity;
      root.attributes = { ...root.attributes, "sdk-tree-identity-reused": "true" };
    } else {
      confirmed = await ports.target();
      if (confirmed.component !== root.attributes?.["debug-component"] || pid !== await ports.pid()) throw new Error("进程或窗口已变化");
      signal?.throwIfAborted();
    }
    return { packageName, pid, component: confirmed.component, windowId: confirmed.windowId, tree: prefetched };
  }
  if (!await sdkTreePhase("provider-check", ports.installed)) return null;
  const before = await sdkTreePhase("window-before", ports.target);
  const pid = await sdkTreePhase("pid-before", ports.pid);
  if (root.attributes?.["debug-process-id"] !== String(pid)) throw new Error("SDK 与独立画面主进程不一致");
  signal?.throwIfAborted();
  const tree = await ports.read();
  const after = await sdkTreePhase("window-after", ports.target);
  if (before.component !== after.component || before.windowId !== after.windowId || pid !== await sdkTreePhase("pid-after", ports.pid)) throw new Error("进程或窗口已变化");
  signal?.throwIfAborted();
  return { packageName, pid, component: before.component, windowId: before.windowId, tree };
}
