export type FloatingInspectorRect = { left: number; top: number; width: number; height: number };
export type WorkspaceLayout = {
  version: 1;
  treeWidth: number;
  inspector: { floating: boolean; rect: FloatingInspectorRect | null };
};
export const WORKSPACE_LAYOUT_STORAGE_KEY = "android-ui-inspector.workspace-layout";
export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = { version: 1, treeWidth: 306, inspector: { floating: false, rect: null } };

const finiteBetween = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

export function parseWorkspaceLayout(value: unknown): WorkspaceLayout | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const layout = value as Partial<WorkspaceLayout>, inspector = layout.inspector;
  if (layout.version !== 1 || !finiteBetween(layout.treeWidth, 120, 720)
    || !inspector || typeof inspector !== "object" || Array.isArray(inspector) || typeof inspector.floating !== "boolean") return null;
  const rect = inspector.rect;
  if (rect !== null && (!rect || typeof rect !== "object" || Array.isArray(rect)
    || !finiteBetween(rect.left, 0, 100000) || !finiteBetween(rect.top, 0, 100000)
    || !finiteBetween(rect.width, 176, 1280) || !finiteBetween(rect.height, 160, 1600))) return null;
  return { version: 1, treeWidth: layout.treeWidth, inspector: {
    floating: inspector.floating, rect: rect && { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
  } };
}

export function readWorkspaceLayout(raw: string | null): { layout: WorkspaceLayout; error: string | null } {
  if (raw === null) return { layout: DEFAULT_WORKSPACE_LAYOUT, error: null };
  try {
    const layout = raw.length <= 2048 ? parseWorkspaceLayout(JSON.parse(raw)) : null;
    if (layout) return { layout, error: null };
  } catch { /* A corrupt preference must not make the workbench inaccessible. */ }
  return { layout: DEFAULT_WORKSPACE_LAYOUT, error: "已恢复默认布局：本机布局配置无法读取。" };
}

export function treePaneWidthBounds(gridWidth: number, handleWidth = 5) {
  const min = Math.min(240, Math.max(120, Math.floor(gridWidth * .4)));
  const canvasMin = Math.min(360, Math.floor(gridWidth * .55));
  return { min, max: Math.max(min, Math.min(720, gridWidth - canvasMin - handleWidth)) };
}

/** Clamp the displayed rectangle only; save the preferred rectangle on user actions. */
export function clampFloatingInspectorRect(rect: FloatingInspectorRect, viewport: { width: number; height: number; minTop?: number }): FloatingInspectorRect {
  const availableWidth = Math.max(1, Number.isFinite(viewport.width) ? viewport.width : 1);
  const availableHeight = Math.max(1, Number.isFinite(viewport.height) ? viewport.height : 1);
  const marginX = Math.min(12, Math.max(0, (availableWidth - 1) / 2));
  const minTop = Math.min(Math.max(0, Number.isFinite(viewport.minTop) ? viewport.minTop! : 12), Math.max(0, availableHeight - 1));
  const bottom = Math.min(16, Math.max(0, availableHeight - minTop - 1));
  const maxWidth = Math.max(1, availableWidth - marginX * 2), maxHeight = Math.max(1, availableHeight - minTop - bottom);
  const width = Math.min(maxWidth, 1280, Math.max(Math.min(248, maxWidth), Number.isFinite(rect.width) ? rect.width : 320));
  const height = Math.min(maxHeight, 1600, Math.max(Math.min(160, maxHeight), Number.isFinite(rect.height) ? rect.height : 400));
  return { left: Math.max(marginX, Math.min(Number.isFinite(rect.left) ? rect.left : marginX, availableWidth - width - marginX)),
    top: Math.max(minTop, Math.min(Number.isFinite(rect.top) ? rect.top : minTop, availableHeight - height - bottom)), width, height };
}
