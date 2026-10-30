import { useCallback, useState } from "react";
import { COLOR_DISPLAY_STORAGE_KEY, DEFAULT_COLOR_FORMAT, parseColorDisplayFormat, type ColorDisplayFormat } from "../../../shared/color-display";

export function useColorDisplay() {
  const [colorFormat, setColorFormat] = useState<ColorDisplayFormat>(() => {
    try { return parseColorDisplayFormat(localStorage.getItem(COLOR_DISPLAY_STORAGE_KEY)) ?? DEFAULT_COLOR_FORMAT; }
    catch { return DEFAULT_COLOR_FORMAT; }
  });
  const [colorFormatSaveError, setSaveError] = useState(false);
  const saveColorFormat = useCallback((value: ColorDisplayFormat) => {
    const next = parseColorDisplayFormat(value);
    if (!next) return false;
    setColorFormat(next);
    try { localStorage.setItem(COLOR_DISPLAY_STORAGE_KEY, next); setSaveError(false); return true; }
    catch { setSaveError(true); return false; }
  }, []);
  return { colorFormat, saveColorFormat, colorFormatSaveError };
}
