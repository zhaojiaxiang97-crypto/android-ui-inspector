/** Only temporary observation failures may be retried after an acknowledged input. */
export class DebugObservationError extends Error {
  constructor(readonly code: "window_changed" | "hierarchy_unavailable", message: string) {
    super(message);
    this.name = "DebugObservationError";
  }
}
