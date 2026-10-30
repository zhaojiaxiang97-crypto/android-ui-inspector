import { preferVerifiedSdkImages } from "../sdk/sdk-capture-route";
import { inspectionModeOrDefault, type InspectionMode } from "../../shared/inspection-mode";

type VerifiedSdkRoute = Omit<Parameters<typeof preferVerifiedSdkImages>[0], "preference">;

/** One attempt's route. Caller policy remains unchanged; only verified SDK evidence can upgrade it. */
export class CapturePlan {
  private visibleSdk: boolean | undefined;
  readonly inspectionMode: InspectionMode;
  constructor(private readonly preference?: boolean, readonly startupRetry = false, mode?: InspectionMode) {
    this.inspectionMode = inspectionModeOrDefault(mode);
    this.visibleSdk = this.allowsSdk ? preference : false;
  }
  get allowsSdk() { return this.inspectionMode === "sdk-enhanced"; }
  requireSdk() {
    if (!this.allowsSdk) throw new Error("当前为标准模式，未启用 SDK 增强。");
  }
  get preferVisibleSdk() { return this.visibleSdk; }
  get imageRoute(): "sdk" | "ddms" { return this.visibleSdk === true ? "sdk" : "ddms"; }
  sdkFirstCandidate(nodeCount: number, hasTreeVerifier: boolean) {
    return this.allowsSdk && hasTreeVerifier && (this.visibleSdk === true || this.visibleSdk === undefined && nodeCount >= 200);
  }
  acceptVerifiedSdk(evidence: VerifiedSdkRoute) {
    if (!this.allowsSdk || !preferVerifiedSdkImages({ ...evidence, preference: this.preference })) return false;
    this.visibleSdk = true;
    return true;
  }
}
