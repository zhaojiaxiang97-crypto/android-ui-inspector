import { useCallback, useState } from "react";
import { parseTreeRowMode, TREE_ROW_MODE_STORAGE_KEY, type TreeRowMode } from "../../../shared/tree-row-mode";

export function useTreeRowMode() {
  const [initial] = useState(() => {
    try { return { mode: parseTreeRowMode(localStorage.getItem(TREE_ROW_MODE_STORAGE_KEY)) ?? "compact" as TreeRowMode, error: false }; }
    catch { return { mode: "compact" as TreeRowMode, error: true }; }
  });
  const [mode, setMode] = useState(initial.mode);
  const [saveError, setSaveError] = useState(initial.error);
  const saveMode = useCallback((value: TreeRowMode) => {
    const next = parseTreeRowMode(value);
    if (!next) return false;
    setMode(next);
    try { localStorage.setItem(TREE_ROW_MODE_STORAGE_KEY, next); setSaveError(false); return true; }
    catch { setSaveError(true); return false; }
  }, []);
  return { mode, saveMode, saveError };
}
