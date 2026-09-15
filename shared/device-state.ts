import type { AdbProbeResult, DeviceInfo } from "./types";

/**
 * The home screen is a state machine, not a proxy for `devices.length`.
 * Keeping this decision pure makes the copy/actions consistent across the
 * renderer, visual fixtures and future native window shells.
 */
export type HomeState =
  | "loading"
  | "adb-missing"
  | "error"
  | "no-device"
  | "unauthorized"
  | "connected";

type ResolveHomeStateInput = {
  loading: boolean;
  runtimeError: string | null;
  probe: AdbProbeResult | null;
  selectedDevice: DeviceInfo | null;
};

export function resolveHomeState({ loading, runtimeError, probe, selectedDevice }: ResolveHomeStateInput): HomeState {
  if (loading) return "loading";
  if (runtimeError) return "error";
  if (!probe) return loading ? "loading" : "error";
  if (!probe.adbPath) return "adb-missing";
  if (probe.error) return "error";
  if (selectedDevice?.state === "device") return "connected";
  if (selectedDevice) return "unauthorized";
  if (probe.devices.some((device) => device.state === "device")) return "connected";
  if (probe.devices.length > 0) return "unauthorized";
  return "no-device";
}

export function homeStateIsError(state: HomeState) {
  return state === "adb-missing" || state === "error";
}

export function homeStateIsConnected(state: HomeState) {
  return state === "connected";
}
