import { useCallback, useState } from "react";
import { DEFAULT_WORKSPACE_LAYOUT, WORKSPACE_LAYOUT_STORAGE_KEY, parseWorkspaceLayout, readWorkspaceLayout,
  type WorkspaceLayout } from "../../../shared/workspace-layout";

export function useWorkspaceLayout() {
  const [state, setState] = useState(() => {
    try { return readWorkspaceLayout(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)); }
    catch { return { layout: DEFAULT_WORKSPACE_LAYOUT, error: "已使用默认布局：无法访问本机布局配置。" }; }
  });
  const saveWorkspaceLayout = useCallback((value: WorkspaceLayout) => {
    const layout = parseWorkspaceLayout(value);
    if (!layout) return false;
    try {
      localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
      setState({ layout, error: null });
      return true;
    } catch {
      setState({ layout, error: "布局已应用到本次窗口，但本机保存失败；重开后可能丢失。" });
      return false;
    }
  }, []);
  const resetWorkspaceLayout = useCallback(() => saveWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT), [saveWorkspaceLayout]);
  return { workspaceLayout: state.layout, saveWorkspaceLayout, resetWorkspaceLayout, workspaceLayoutError: state.error };
}
