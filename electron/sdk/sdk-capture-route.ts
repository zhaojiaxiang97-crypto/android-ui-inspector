/** Route selection only, after this request's SDK tree/identity validation. */
export function preferVerifiedSdkImages(input: {
  preference?: boolean;
  nodeCount: number;
  verified: boolean;
  visibleStream: unknown;
  uiWake: unknown;
  hardwareAccelerated: unknown;
}): boolean {
  if (input.preference === false || !input.verified) return false;
  if (input.preference === true || input.nodeCount >= 200) return true;
  return input.visibleStream === "2" && input.uiWake === "1"
    && (input.hardwareAccelerated === "true" || input.hardwareAccelerated === "false");
}
