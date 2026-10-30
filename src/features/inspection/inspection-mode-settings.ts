import { DEFAULT_INSPECTION_MODE, isInspectionMode, type InspectionMode, type InspectionModeState } from "../../../shared/inspection-mode";
import type { InspectionModePort } from "../../platform/desktop-services";

export type InspectionModeSettingsState = InspectionModeState & {
  available: boolean;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
};

function modeState(value: unknown): InspectionModeState {
  const next = value as Partial<InspectionModeState> | null;
  if (!next || !isInspectionMode(next.mode) || !Number.isSafeInteger(next.revision) || next.revision! < 0 || typeof next.busy !== "boolean")
    throw new Error("桌面应用返回的采集设置无效，请重试或更新应用。");
  return next as InspectionModeState;
}
const message = (error: unknown, fallback: string) => typeof error === "string" ? error : error instanceof Error ? error.message : fallback;

/** The main process owns persistence. Events and replies share one revision order. */
export function createInspectionModeSettings(api: InspectionModePort | undefined, onRevision: () => void, blocked: () => boolean = () => false) {
  let state: InspectionModeSettingsState = { mode: DEFAULT_INSPECTION_MODE, revision: 0, busy: false,
    available: Boolean(api), loaded: false, loading: Boolean(api), saving: false, error: null };
  let connected = false, lifetime = 0, events = 0, observed = false, loading = false;
  let unsubscribe: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<InspectionModeSettingsState>) => {
    state = { ...state, ...patch }; for (const listener of listeners) listener();
  };
  function accept(value: unknown, requestEvents?: number) {
    const next = modeState(value);
    if (observed && (next.revision < state.revision || requestEvents !== undefined && requestEvents !== events && next.revision === state.revision)) return;
    if (observed && next.revision !== state.revision) onRevision();
    observed = true;
    publish(next);
  }
  async function reload() {
    if (!connected || !api || loading || state.saving) return;
    loading = true;
    const epoch = lifetime, started = events;
    publish({ loading: true, error: null });
    try {
      if (!unsubscribe) unsubscribe = api.onInspectionMode(next => {
        if (!connected || epoch !== lifetime) return;
        events++;
        try { accept(next); }
        catch (error) { publish({ loaded: false, error: message(error, "采集设置更新失败，请重试。") }); }
      });
      const next = await api.getInspectionMode();
      if (!connected || epoch !== lifetime) return;
      accept(next, started);
      publish({ loaded: true });
    } catch (error) {
      if (connected && epoch === lifetime) publish({ loaded: false, error: message(error, "无法读取采集设置，请重试。") });
    } finally {
      if (connected && epoch === lifetime) { loading = false; publish({ loading: false }); }
    }
  }
  function dispose() {
    if (!connected) return;
    connected = false; lifetime++; loading = false; unsubscribe?.(); unsubscribe = undefined;
    publish({ loaded: false, loading: Boolean(api), saving: false });
  }
  return {
    getState: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    connect() {
      if (connected) return dispose;
      connected = true;
      if (api) void reload();
      return dispose;
    },
    dispose, reload,
    async setMode(mode: InspectionMode) {
      if (!connected || !api || !state.loaded || state.loading || state.saving || state.busy || blocked() || mode === state.mode || !isInspectionMode(mode)) return;
      const epoch = lifetime, started = events;
      publish({ saving: true, error: null });
      try {
        const next = await api.setInspectionMode(mode);
        if (connected && epoch === lifetime) accept(next, started);
      } catch (error) {
        if (connected && epoch === lifetime) publish({ error: message(error, "保存采集设置失败，请重试。") });
      } finally {
        if (connected && epoch === lifetime) publish({ saving: false });
      }
    },
  };
}
