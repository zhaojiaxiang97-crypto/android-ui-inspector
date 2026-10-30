import { preferVerifiedSdkImages } from "../sdk/sdk-capture-route";

type VerifiedSdkRoute = Omit<Parameters<typeof preferVerifiedSdkImages>[0], "preference">;

/** One attempt's route. Caller policy remains unchanged; only verified SDK evidence can upgrade it. */
export class CapturePlan {
  private visibleSdk: boolean | undefined;
  constructor(private readonly preference?: boolean, readonly startupRetry = false) { this.visibleSdk = preference; }
  get preferVisibleSdk() { return this.visibleSdk; }
  get imageRoute(): "sdk" | "ddms" { return this.visibleSdk === true ? "sdk" : "ddms"; }
  sdkFirstCandidate(nodeCount: number, hasTreeVerifier: boolean) {
    return hasTreeVerifier && (this.visibleSdk === true || this.visibleSdk === undefined && nodeCount >= 200);
  }
  acceptVerifiedSdk(evidence: VerifiedSdkRoute) {
    if (!preferVerifiedSdkImages({ ...evidence, preference: this.preference })) return false;
    this.visibleSdk = true;
    return true;
  }
}
