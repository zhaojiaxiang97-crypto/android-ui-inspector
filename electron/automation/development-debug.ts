/** Explicit local development convenience. Never affects packaged releases or Helper pairing. */
export type DevelopmentDebugTarget = { serial: string; packageName: string };

type DevelopmentEnvironment = Record<string, string | undefined>;

export function developmentDebugTarget(env: DevelopmentEnvironment, isPackaged: boolean): DevelopmentDebugTarget | null {
  if (isPackaged || env.ANDROID_UI_INSPECTOR_DEV_AUTO_DEBUG !== "1") return null;
  const serial = env.ANDROID_UI_INSPECTOR_DEV_SERIAL;
  const packageName = env.ANDROID_UI_INSPECTOR_DEV_PACKAGE;
  if (!serial || !/^[\w.:-]{1,256}$/.test(serial))
    throw new Error("开发自动调试需要有效的 ANDROID_UI_INSPECTOR_DEV_SERIAL。");
  if (!packageName || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName))
    throw new Error("开发自动调试需要有效的 ANDROID_UI_INSPECTOR_DEV_PACKAGE。");
  return { serial, packageName };
}

export function developmentTargetMatches(target: DevelopmentDebugTarget | null, serial: string, packageName: string): boolean {
  return Boolean(target && target.serial === serial && target.packageName === packageName);
}
