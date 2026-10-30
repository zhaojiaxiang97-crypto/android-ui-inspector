import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CONTEXT_HINT_STORAGE_KEY, DEFAULT_CONTEXT_HINTS, clearContextHint, dismissContextHint, markContextHintShown,
  newContextHintSession, readContextHintPreference, requestContextHint, type ContextHintId, type ContextHintPreference,
  type ContextHintSession } from "../../../shared/context-hints";

export type ContextHintsController = {
  hint: ContextHintId | null;
  suspended: boolean;
  requestHint: (id: ContextHintId) => void;
  markShown: (id: ContextHintId) => void;
  dismissHint: (id: ContextHintId) => void;
  clearHint: (id: ContextHintId) => void;
  resetHints: () => boolean;
  acknowledgedCount: number;
};

const documentBlocked = () => typeof document !== "undefined" && (document.visibilityState === "hidden" || Boolean(document.querySelector("dialog[open]")));

export function useContextHints(sessionKey: string | number | null, suspended = false): ContextHintsController {
  const [preference, setPreference] = useState<ContextHintPreference>(() => {
    try { return readContextHintPreference(localStorage.getItem(CONTEXT_HINT_STORAGE_KEY)); }
    catch { return DEFAULT_CONTEXT_HINTS; }
  });
  const [session, setSession] = useState<ContextHintSession>(newContextHintSession);
  const [blocked, setBlocked] = useState(documentBlocked);
  const state = useRef({ key: sessionKey, preference, session, suspended });
  state.current.suspended = suspended;

  const updateSession = useCallback((next: ContextHintSession) => {
    if (state.current.session === next) return;
    state.current.session = next;
    setSession(next);
  }, []);
  const save = useCallback((next: ContextHintPreference) => {
    state.current.preference = next;
    setPreference(next);
    try { localStorage.setItem(CONTEXT_HINT_STORAGE_KEY, JSON.stringify(next)); return true; }
    catch { return false; }
  }, []);

  useLayoutEffect(() => {
    if (!Object.is(state.current.key, sessionKey)) {
      state.current.key = sessionKey;
      updateSession(newContextHintSession());
    }
  }, [sessionKey, updateSession]);

  useEffect(() => {
    const changed = () => setBlocked(documentBlocked());
    const observer = new MutationObserver(changed);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
    document.addEventListener("visibilitychange", changed);
    changed();
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", changed); };
  }, []);

  const requestHint = useCallback((id: ContextHintId) => {
    if (state.current.key === null) return;
    updateSession(requestContextHint(state.current.session, state.current.preference, id));
  }, [updateSession]);
  const markShown = useCallback((id: ContextHintId) => {
    if (state.current.suspended || documentBlocked()) return;
    updateSession(markContextHintShown(state.current.session, id));
  }, [updateSession]);
  const dismissHint = useCallback((id: ContextHintId) => {
    const result = dismissContextHint(state.current.session, state.current.preference, id);
    updateSession(result.session);
    if (result.preference !== state.current.preference) save(result.preference);
  }, [save, updateSession]);
  const clearHint = useCallback((id: ContextHintId) => {
    updateSession(clearContextHint(state.current.session, id));
  }, [updateSession]);
  const resetHints = useCallback(() => {
    updateSession(newContextHintSession());
    return save({ version: 1, acknowledged: [] });
  }, [save, updateSession]);

  return {
    hint: Object.is(state.current.key, sessionKey) ? session.pending : null,
    suspended: suspended || blocked,
    requestHint, markShown, dismissHint, clearHint, resetHints, acknowledgedCount: preference.acknowledged.length,
  };
}
