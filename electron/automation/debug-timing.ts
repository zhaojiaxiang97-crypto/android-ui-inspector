// Keep upper-layer callers on this facade while device runtime owns the shared timing context.
// Re-exporting preserves one AsyncLocalStorage instance across observations and device commands.
export {
  DebugTiming,
  createDebugTiming,
  runWithDebugTiming,
  getDebugTimings,
  withDebugObservationReason,
  debugTimingErrorOutcome,
  measureDebugPhase,
  measureDebugPhaseSync,
  measureDebugCommand,
  debugCommandCategory,
} from "../device/debug-timing";
