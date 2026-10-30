import { inspectionModeOrDefault, isInspectionMode, type InspectionMode, type InspectionModeState } from "../../shared/inspection-mode";

export interface InspectionModeControllerDependencies {
  load(): unknown;
  save(mode: InspectionMode): Promise<void>;
  isBusy(): boolean;
  releaseSdk(): Promise<void>;
  invalidate(): void;
  notify(state: InspectionModeState): void;
}

/** The desktop owns policy; snapshots and individual capture requests cannot enable it. */
export function createInspectionModeController(dependencies: InspectionModeControllerDependencies) {
  let mode = inspectionModeOrDefault(dependencies.load());
  let revision = 0;
  let changing = false;
  const state = (): InspectionModeState => ({ mode, revision, busy: changing || dependencies.isBusy() });
  function capture() {
    if (changing) throw new Error("正在切换采集模式，请稍后重试。");
    return { mode, revision };
  }
  async function set(value: unknown) {
    if (!isInspectionMode(value)) throw new Error("采集模式无效。");
    if (changing || dependencies.isBusy()) throw new Error("请先结束采集、刷新、连接诊断或自动调试，再切换 SDK 增强。");
    if (value === mode) return state();
    changing = true;
    dependencies.notify(state());
    try {
      await dependencies.releaseSdk();
      await dependencies.save(value);
      mode = value;
      revision++;
      dependencies.invalidate();
    } finally {
      changing = false;
      dependencies.notify(state());
    }
    return state();
  }
  return { state, capture, set };
}
