import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { acceptLivePreviewEvent, type LivePreviewApi, type LivePreviewEvent } from "../../../shared/live-preview";

function availableApi(): LivePreviewApi | null {
  const api = window.electronApi as unknown as Partial<LivePreviewApi>;
  return api.startLivePreview && api.pauseLivePreview && api.resumeLivePreview && api.stopLivePreview
    && api.getLivePreview && api.onLivePreview ? api as LivePreviewApi : null;
}

type View = { scope: object; event: LivePreviewEvent | null; pending: boolean; error: string | null };
type Subscription = {
  scope: object;
  active: boolean;
  sessionId: string | null;
  pending: boolean;
  apply: (event: LivePreviewEvent) => void;
  api: LivePreviewApi;
};

export function useLivePreview({ serial, connected, enabled, api: suppliedApi }: {
  serial: string;
  connected: boolean;
  enabled: boolean;
  api?: LivePreviewApi;
}) {
  const api = suppliedApi ?? availableApi();
  const [restart, setRestart] = useState(0);
  const scope = useMemo(() => ({}), [serial, enabled, api, restart]);
  const [view, setView] = useState<View | null>(null);
  const current = useRef<Subscription | null>(null);
  const disconnectedScope = useRef<object | null>(null);

  useEffect(() => {
    setView({ scope, event: null, pending: false, error: null });
    if (!enabled) return;
    if (!connected) { disconnectedScope.current = scope; return; }
    // A reconnect needs a fresh user request; the former stream stays closed.
    if (disconnectedScope.current === scope) return;
    if (!api) {
      setView({ scope, event: null, pending: false, error: "当前版本不支持实时预览。" });
      return;
    }
    let queued: LivePreviewEvent | null = null;
    const subscription: Subscription = { scope, active: true, sessionId: null, pending: true, api,
      apply: event => {
        if (!subscription.active || !subscription.sessionId) return;
        setView(previous => {
          if (previous?.scope !== scope) return previous;
          const next = acceptLivePreviewEvent(previous.event, event, serial, subscription.sessionId!);
          return next === previous.event ? previous : { ...previous, event: next, error: null };
        });
      },
    };
    current.current = subscription;
    setView({ scope, event: null, pending: true, error: null });
    const unsubscribe = api.onLivePreview(event => {
      if (!subscription.active || event.state.serial !== serial) return;
      if (subscription.sessionId) subscription.apply(event);
      else if (!queued || event.state.revision > queued.state.revision) queued = event;
    });
    void api.startLivePreview(serial).then(event => {
      const sessionId = event.state.serial === serial ? event.state.sessionId : null;
      if (!subscription.active) {
        if (sessionId) void api.stopLivePreview(sessionId).catch(() => {});
        return;
      }
      if (!sessionId) throw Error("预览未能开启，请重试。");
      subscription.sessionId = sessionId;
      subscription.apply(event);
      if (queued) subscription.apply(queued);
    }).catch(error => {
      if (subscription.active) setView(previous => previous?.scope === scope
        ? { ...previous, error: error instanceof Error ? error.message : "预览开启失败。" } : previous);
    }).finally(() => {
      subscription.pending = false;
      if (subscription.active) setView(previous => previous?.scope === scope ? { ...previous, pending: false } : previous);
    });
    return () => {
      subscription.active = false;
      if (current.current === subscription) current.current = null;
      unsubscribe();
      if (subscription.sessionId) void api.stopLivePreview(subscription.sessionId).catch(() => {});
    };
  }, [serial, connected, enabled, api, scope]);

  const control = useCallback(async (action: "pause" | "resume") => {
    const subscription = current.current;
    if (!subscription?.active || !subscription.sessionId || subscription.pending) return;
    subscription.pending = true;
    setView(previous => previous?.scope === subscription.scope ? { ...previous, pending: true, error: null } : previous);
    try {
      const event = await (action === "pause" ? subscription.api.pauseLivePreview(subscription.sessionId)
        : subscription.api.resumeLivePreview(subscription.sessionId));
      subscription.apply(event);
    } catch (error) {
      if (subscription.active) setView(previous => previous?.scope === subscription.scope
        ? { ...previous, error: error instanceof Error ? error.message : "预览操作失败。" } : previous);
    } finally {
      subscription.pending = false;
      if (subscription.active) setView(previous => previous?.scope === subscription.scope ? { ...previous, pending: false } : previous);
    }
  }, []);

  const visible = enabled && connected && view?.scope === scope ? view : null;
  return {
    state: visible?.event?.state ?? null,
    frame: visible?.event?.frame ?? null,
    pending: visible?.pending ?? false,
    error: visible?.error ?? null,
    supported: Boolean(api),
    pause: useCallback(() => control("pause"), [control]),
    resume: useCallback(() => control("resume"), [control]),
    start: useCallback(() => setRestart(value => value + 1), []),
  };
}
