import { useCallback, useLayoutEffect, useState } from "react";
import { APPEARANCE_STORAGE_KEY, DEFAULT_APPEARANCE, parseAppearancePreference, readAppearancePreference, resolveAppearance,
  type AppearancePreference } from "../../../shared/appearance";
import "../../styles/appearance.css";

export function useAppearance() {
  const [appearance, setAppearance] = useState<AppearancePreference>(() => {
    try { return readAppearancePreference(localStorage.getItem(APPEARANCE_STORAGE_KEY)); }
    catch { return DEFAULT_APPEARANCE; }
  });
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [appearanceSaveError, setAppearanceSaveError] = useState(false);
  const resolvedAppearance = resolveAppearance(appearance, systemDark);

  useLayoutEffect(() => {
    if (appearance !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [appearance]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute("data-appearance");
    root.dataset.appearance = resolvedAppearance;
    return () => {
      if (previous === null) root.removeAttribute("data-appearance");
      else root.setAttribute("data-appearance", previous);
    };
  }, [resolvedAppearance]);

  const saveAppearance = useCallback((value: AppearancePreference) => {
    const next = parseAppearancePreference(value);
    if (!next) return false;
    setAppearance(next);
    try {
      localStorage.setItem(APPEARANCE_STORAGE_KEY, next);
      setAppearanceSaveError(false);
      return true;
    } catch {
      setAppearanceSaveError(true);
      return false;
    }
  }, []);
  return { appearance, resolvedAppearance, saveAppearance, appearanceSaveError };
}
