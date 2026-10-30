import type { DebugInputEvidence } from "./types";

/** Helper transport has no child process; a missing receipt still means possible input. */
export function debugInputMayHaveDispatched(evidence: DebugInputEvidence | undefined): boolean {
  if (!evidence) return false;
  return evidence.transport === "accessibility-helper"
    ? evidence.helperInput?.dispatchState !== "not_sent" : evidence.spawned;
}
