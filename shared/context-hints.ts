export type ContextHintId = "quick-select" | "layer-focus" | "pinned-measurement";
export type ContextHintPreference = { version: 1; acknowledged: readonly ContextHintId[] };
export type ContextHintSession = { pending: ContextHintId | null; shown: ContextHintId | null };

export const CONTEXT_HINTS: readonly { id: ContextHintId; text: string }[] = [
  { id: "quick-select", text: "点画面查看重叠图层；悬停候选预览边界，方向键切换。" },
  { id: "layer-focus", text: "点击“退出聚焦”返回完整层级，并恢复之前的视角。" },
  { id: "pinned-measurement", text: "测距已固定，旋转时仍保留这对控件；按 M 解除。" },
];
export const DEFAULT_CONTEXT_HINTS: ContextHintPreference = { version: 1, acknowledged: [] };
export const CONTEXT_HINT_STORAGE_KEY = "android-ui-inspector.context-hints";
export const MAX_CONTEXT_HINT_PREFERENCE_LENGTH = 512;

const isHintId = (value: unknown): value is ContextHintId => typeof value === "string" && CONTEXT_HINTS.some(hint => hint.id === value);

export function parseContextHintPreference(value: unknown): ContextHintPreference | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const data = value as { version?: unknown; acknowledged?: unknown };
    if (data.version !== 1 || !Array.isArray(data.acknowledged) || data.acknowledged.length > CONTEXT_HINTS.length) return null;
    if (!data.acknowledged.every(isHintId) || JSON.stringify(value).length > MAX_CONTEXT_HINT_PREFERENCE_LENGTH) return null;
    return { version: 1, acknowledged: [...new Set(data.acknowledged as ContextHintId[])] };
  } catch { return null; }
}

export function readContextHintPreference(raw: string | null): ContextHintPreference {
  if (!raw || raw.length > MAX_CONTEXT_HINT_PREFERENCE_LENGTH) return DEFAULT_CONTEXT_HINTS;
  try { return parseContextHintPreference(JSON.parse(raw)) ?? DEFAULT_CONTEXT_HINTS; }
  catch { return DEFAULT_CONTEXT_HINTS; }
}

export function newContextHintSession(): ContextHintSession { return { pending: null, shown: null }; }

// A request may wait behind capture, a gesture or a dialog; it consumes no opportunity yet.
export function requestContextHint(session: ContextHintSession, preference: ContextHintPreference, id: ContextHintId): ContextHintSession {
  return session.shown || session.pending || preference.acknowledged.includes(id) ? session : { ...session, pending: id };
}

export function markContextHintShown(session: ContextHintSession, id: ContextHintId): ContextHintSession {
  return session.pending === id && !session.shown ? { ...session, shown: id } : session;
}

// Ending an operation withdraws its hint without acknowledging it or resetting the visible-hint budget.
export function clearContextHint(session: ContextHintSession, id: ContextHintId): ContextHintSession {
  return session.pending === id ? { ...session, pending: null } : session;
}

export function dismissContextHint(session: ContextHintSession, preference: ContextHintPreference, id: ContextHintId): {
  session: ContextHintSession; preference: ContextHintPreference;
} {
  if (session.pending !== id) return { session, preference };
  return {
    session: clearContextHint(session, id),
    // Only an actually displayed hint is remembered. Stale or hidden callbacks cannot acknowledge it.
    preference: session.shown === id && !preference.acknowledged.includes(id)
      ? { version: 1, acknowledged: [...preference.acknowledged, id] } : preference,
  };
}
