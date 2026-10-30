import type { CaptureGeometry } from "../../shared/types";
import { parseInputDisplay, pngSize } from "./capture-display";
import { runCommand, runDeviceAdb, type CommandResult } from "./runtime";


export async function readDisplayFrame(adbPath: string, serial: string) {
  try {
    const result = await runCommand(adbPath, ["-s", serial, "shell", "dumpsys", "input"], 5_000);
    return result.code === 0 ? parseInputDisplay(result.stdout.toString("utf8")) : null;
  } catch {
    // Optional diagnostics must not turn a usable hierarchy into a failed capture.
    return null;
  }
}

export type ScreenCaptureOptions = {
  // Observation-only streams skip dumpsys; inspection retains its existing checks.
  readGeometry?: boolean;
  runScreenshot?: (adbPath: string, serial: string) => Promise<CommandResult>;
};

export async function captureScreen(adbPath: string, serial: string, options: ScreenCaptureOptions = {}) {
  const beforeScreenshot = options.readGeometry === false ? null : await readDisplayFrame(adbPath, serial);
  const result = options.runScreenshot
    ? await options.runScreenshot(adbPath, serial)
    : await runDeviceAdb(adbPath, serial, ["exec-out", "screencap", "-p"]);
  const screenshotSize = pngSize(result.stdout);
  if (result.code !== 0 || !screenshotSize) return { result, screenshotDataUrl: null, captureGeometry: undefined };
  const afterScreenshot = options.readGeometry === false ? null : await readDisplayFrame(adbPath, serial);
  const captureGeometry: CaptureGeometry | undefined = options.readGeometry === false ? undefined
    : { hierarchyRotation: beforeScreenshot?.rotation ?? null, beforeScreenshot, afterScreenshot, screenshotSize };
  return {
    result,
    screenshotDataUrl: `data:image/png;base64,${result.stdout.toString("base64")}`,
    captureGeometry,
  };
}
