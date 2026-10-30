import type { AdbProbeResult } from "../../shared/types";
import { connectionDiagnosticRequest, diagnosticOutcome, type ConnectionDiagnosticRequest, type ConnectionDiagnosticReport,
  type ConnectionDiagnosticCheck, type DiagnosticCheckId, type DiagnosticObservation } from "../../shared/connection-diagnostics";
import { probeAdb } from "../device/probe";
import { foregroundTarget, readDebugFocus, sameActivityInstance, type ForegroundTarget } from "../device/target";
import { withCommandSignal } from "../device/command-context";
import { runDeviceAdb, type CommandResult } from "../device/runtime";
import { readHelperToken } from "../capture/accessibility-helper";
import type { InspectionMode } from "../../shared/inspection-mode";

export type ConnectionDiagnosticOptions = {
  /** Trusted desktop policy only; never read from the CLI/MCP request. */
  inspectionMode?: InspectionMode;
  signal?: AbortSignal;
  automationConnection?: (signal: AbortSignal, observedPackageName?: string) => DiagnosticObservation | Promise<DiagnosticObservation>;
  probe?: () => Promise<AdbProbeResult>;
  command?: typeof runDeviceAdb;
  focus?: typeof readDebugFocus;
  helperConfig?: () => void;
};

const pass = (code: string, detail: string): DiagnosticObservation => ({ status: "pass", code, detail, suggestion: null });
const fail = (code: string, detail: string, suggestion: string): DiagnosticObservation => ({ status: "fail", code, detail, suggestion });
const unknown = (code: string, detail: string): DiagnosticObservation => ({ status: "unknown", code, detail, suggestion: "保持设备连接和目标页面稳定后，手动重新诊断。" });

/** Accept explicit lock state only; Android/OEM text that we cannot interpret stays unknown. */
export function diagnosticScreenState(output: string): DiagnosticObservation {
  const keyguard = output.match(/(?:KeyguardServiceDelegate|mKeyguardDelegate)[\s\S]*?(?=\n\s*\S[^\n]*:\s*\n|$)/)?.[0] ?? "";
  const locked = [...output.matchAll(/\b(?:mShowingLockscreen|isKeyguardShowing|mKeyguardShowing|mInputRestricted)=(true|false)\b/g),
    ...keyguard.matchAll(/\b(?:showing|showingAndNotOccluded|inputRestricted)=(true|false)\b/g)].map(match => match[1]);
  const asleep = /\b(?:mWakefulness=Asleep|mInteractive=false|interactive=false)\b/.test(output);
  if (locked.includes("true") || asleep)
    return fail("screen-locked", "设备锁屏或屏幕尚未唤醒。", "请在手机上手动点亮屏幕并解锁，再打开目标 App。");
  if (locked.includes("false")) return pass("screen-unlocked", "系统明确报告当前没有锁屏限制。");
  return unknown("screen-unavailable", "系统没有提供可识别的锁屏状态。");
}

function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    if (signal.aborted) aborted();
  });
}

export async function diagnoseConnection(raw: ConnectionDiagnosticRequest, options: ConnectionDiagnosticOptions = {}): Promise<ConnectionDiagnosticReport> {
  const request = connectionDiagnosticRequest.parse(raw);
  const sdkEnabled = options.inspectionMode === "sdk-enhanced";
  const startedAt = new Date().toISOString(), started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("诊断已超时。")), request.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const probe = options.probe ?? probeAdb, command = options.command ?? runDeviceAdb, focus = options.focus ?? readDebugFocus;
  const helperConfig = options.helperConfig ?? (() => { readHelperToken(process.env.ANDROID_UI_INSPECTOR_HELPER_TOKEN_FILE); });
  const specs: [DiagnosticCheckId, string, boolean][] = [
    ["adb", "ADB 工具", true], ["device", "设备连接", true], ["authorization", "USB 调试授权", true],
    ["screen", "锁屏状态", true], ["foreground", "目标 App 与窗口", true], ["debuggable", "Debug App", true],
    ["helper", "无障碍 Helper", request.backend === "accessibility-helper"], ["sdk", "SDK 安装声明", false],
    ["automation", "CLI / MCP 连接", request.client !== "desktop"],
  ];
  const checks: ConnectionDiagnosticCheck[] = specs.map(([id, label, required]) => ({ id, label, required, checkedAt: null,
    ...(id === "sdk" && !sdkEnabled
      ? { status: "unknown" as const, code: "sdk-enhancement-disabled", detail: "SDK 增强未启用；已跳过 SDK 安装声明检查，基础采集不要求接入 SDK。", suggestion: null }
      : unknown("not-checked", "尚未检查；设备状态不可用时不猜测其他检查结果。")) }));
  const identity: ConnectionDiagnosticReport["identity"] = { serial: request.serial, transportId: null, packageName: null, component: null, windowId: null };
  let status: ConnectionDiagnosticReport["status"] = "completed";
  const record = (id: DiagnosticCheckId, observation: DiagnosticObservation) => {
    signal.throwIfAborted();
    const index = checks.findIndex(check => check.id === id);
    checks[index] = { ...checks[index], ...observation, detail: observation.detail.slice(0, 768),
      suggestion: observation.suggestion?.slice(0, 768) ?? null, checkedAt: new Date().toISOString() };
  };
  const check = async <T>(id: DiagnosticCheckId, work: () => Promise<T>, describe: (value: T) => DiagnosticObservation): Promise<T | null> => {
    signal.throwIfAborted();
    try { const value = await abortable(Promise.resolve().then(work), signal); record(id, describe(value)); return value; }
    catch {
      signal.throwIfAborted();
      record(id, unknown(`${id}-unavailable`, "检查请求失败，未获得可靠结果。")); return null;
    }
  };
  const output = (result: CommandResult) => result.stdout.toString("utf8");
  try {
    await withCommandSignal(signal, async () => {
      if (options.automationConnection) await check("automation", async () => options.automationConnection!(signal, request.packageName), value => value);
      const initial = await check("adb", probe, value => value.adbPath
        ? value.error ? fail("adb-error", "ADB 无法读取设备列表。", "检查 ADB 安装和 USB 连接后重试。") : pass("adb-available", "已找到 ADB 并读取设备列表。")
        : fail("adb-missing", "没有找到 ADB。", "安装 Android SDK Platform-Tools，配置 ADB 路径后重试。"));
      if (!initial?.adbPath || initial.error) return;
      const device = initial.devices.find(item => item.serial === request.serial);
      if (!device) {
        record("device", fail("device-missing", "当前设备不在 ADB 列表中。", "检查数据线与 USB 调试，并重新选择设备。")); return;
      }
      identity.transportId = device.transportId;
      record("device", device.state === "device" || device.state === "unauthorized" ? pass("device-found", `已发现设备${device.model ? `：${device.model}` : ""}。`)
        : fail("device-offline", "ADB 报告设备离线或不可用。", "重新连接数据线，待设备恢复在线后重试。"));
      record("authorization", device.state === "device" ? pass("device-authorized", "当前电脑已获得 USB 调试授权。")
        : device.state === "unauthorized" ? fail("device-unauthorized", "手机尚未授权当前电脑。", "在手机的 USB 调试提示中手动允许当前电脑。")
          : unknown("authorization-unavailable", "设备离线，无法确认当前电脑的授权。"));
      if (device.state !== "device") return;
      const adbPath = initial.adbPath;
      await check("screen", () => command(adbPath, request.serial, ["shell", "dumpsys", "window", "policy"], 5000), value => value.code === 0
        ? diagnosticScreenState(output(value)) : unknown("screen-unavailable", "无法读取系统锁屏状态。"));
      let target: ForegroundTarget | null = null;
      let windowId: string | null = null;
      await check("foreground", async () => {
        const activities = await command(adbPath, request.serial, ["shell", "dumpsys", "activity", "activities"], 5000);
        if (activities.code !== 0) return unknown("foreground-unavailable", "无法读取前台 App。");
        target = foregroundTarget(output(activities));
        if (!target || !/^[\w]+(?:\.[\w]+)+$/.test(target.packageName)) return unknown("foreground-unavailable", "系统没有提供可识别的前台 App。");
        identity.packageName = target.packageName; identity.component = target.component;
        if (request.packageName && target.packageName !== request.packageName)
          return fail("foreground-mismatch", `前台 App 是 ${target.packageName}，与目标 App 不符。`, `请在手机上手动打开 ${request.packageName}，再重新诊断。`);
        const focused = await focus(adbPath, request.serial);
        if (focused.packageName !== target.packageName)
          return fail("focus-mismatch", "焦点窗口不属于目标 App。", "请手动关闭系统弹窗，保持目标 App 在前台。");
        windowId = focused.id; identity.windowId = focused.id;
        return pass("foreground-ready", `已确认 ${target.packageName} 的前台窗口。`);
      }, value => value);
      const packageName = request.packageName ?? identity.packageName;
      if (packageName) {
        await check("debuggable", () => command(adbPath, request.serial, ["shell", "run-as", packageName, "id"], 5000), value => value.code === 0
          ? pass("app-debuggable", "目标 App 允许当前 Debug 采集方式。")
          : /not debuggable|is unknown|unknown package|not installed/i.test(output(value) + value.stderr)
            ? fail("app-not-debuggable", "目标 App 不可调试或没有安装。", "使用已安装的 Debug App；请手动安装或打开正确的构建。")
            : unknown("debuggable-unavailable", "run-as 检查失败，无法确认目标 App 是否可调试。"));
        if (sdkEnabled) await check("sdk", () => command(adbPath, request.serial, ["shell", "dumpsys", "package", packageName], 5000), value => {
          if (value.code !== 0 || !output(value).trim()) return unknown("sdk-unavailable", "无法读取 SDK 安装声明。");
          if (!output(value).includes(`${packageName}/com.androiduiinspector.sdk.HierarchyProvider:`))
            return fail("sdk-missing", "没有发现 Inspector SDK Provider；深度采集仍可尝试 View Debug。", "需要 SDK 属性时，在目标 Debug App 中接入并启用 Inspector SDK。");
          const disabled = output(value).match(/disabledComponents:\s*\n((?:[ \t]+[\w.$]+\s*\n?)*)/)?.[1] ?? "";
          if (disabled.includes("com.androiduiinspector.sdk.HierarchyProvider"))
            return fail("sdk-disabled", "Inspector SDK Provider 被禁用。", "在目标 App 构建中检查 SDK 配置；诊断不会启用组件。");
          return pass("sdk-declared", "已发现 SDK Provider 声明；运行响应和实际采集结果尚未验证。");
        });
      }
      await check("helper", async () => {
        const enabled = await command(adbPath, request.serial, ["shell", "settings", "get", "secure", "enabled_accessibility_services"], 5000);
        if (enabled.code !== 0 || !output(enabled).trim()) return unknown("helper-unavailable", "无法读取 Helper 启用状态。");
        const services = output(enabled).trim();
        if (!services.split(":").some(service => /^(?:com\.artemis\.helper|com\.androiduiinspector\.a11yhelper)\/(?:com\.artemis\.helper\.)?\.?ArtemisAccessibilityService$/.test(service)))
          return fail("helper-disabled", "无障碍 Helper 未启用；UIAutomator 不需要它。", "仅在选择 Helper 时，在手机上手动安装、启用并配对现有 Helper；也可改用 UIAutomator。");
        try { helperConfig(); }
        catch { return fail("helper-config", "Helper 已启用，但桌面缺少有效的私有配对配置。", "配置现有 Helper 的私有令牌文件后重试；诊断不会安装、启用或重新配对。"); }
        return unknown("helper-enabled", "Helper 已启用且配对配置可读；只读状态检查未验证服务响应或控件树。");
      }, value => value);

      if (options.automationConnection)
        await check("automation", async () => options.automationConnection!(signal, packageName ?? undefined), value => value);

      // Pin the original device transport and App/window; never publish changed identity as ready.
      const latest = await abortable(probe(), signal);
      const currentDevice = latest.devices.find(item => item.serial === request.serial);
      if (latest.error) { record("device", unknown("device-confirmation-unavailable", "诊断结束时无法复核设备连接。")); return; }
      if (!currentDevice || currentDevice.state !== "device"
        || device.transportId && currentDevice.transportId !== device.transportId) {
        status = "identity_changed";
        record("device", unknown("device-changed", "诊断期间设备连接发生变化，本轮结果已失效。")); return;
      }
      const capturedTarget = target as ForegroundTarget | null;
      if (capturedTarget) {
        const currentActivities = await abortable(command(adbPath, request.serial, ["shell", "dumpsys", "activity", "activities"], 5000), signal);
        const current = currentActivities.code === 0 ? foregroundTarget(output(currentActivities)) : null;
        const currentFocus = windowId ? await abortable(focus(adbPath, request.serial), signal).catch(() => null) : null;
        if (!current || windowId && !currentFocus) {
          record("foreground", unknown("foreground-confirmation-unavailable", "诊断结束时无法复核目标 App 或窗口。")); return;
        }
        if (!sameActivityInstance(capturedTarget, current) || windowId && (currentFocus?.id !== windowId || currentFocus.packageName !== capturedTarget.packageName)) {
          status = "identity_changed";
          record("foreground", unknown("foreground-changed", "诊断期间目标 App 或窗口发生变化，本轮结果已失效。"));
        }
      }
    });
    signal.throwIfAborted();
  } catch {
    if (signal.aborted) status = options.signal?.aborted ? "cancelled" : "timed_out";
    else record("foreground", unknown("identity-confirmation-unavailable", "诊断结束时未能完成设备与 App 身份复核。"));
  } finally { clearTimeout(timeout); }
  const incomplete = status !== "completed";
  return { version: 1, requestId: request.requestId, serial: request.serial, expectedPackageName: request.packageName ?? null,
    captureMode: request.captureMode, backend: request.backend, client: request.client, startedAt,
    completedAt: new Date().toISOString(), elapsedMs: Math.max(0, Math.round(performance.now() - started)), status,
    outcome: incomplete ? "unknown" : diagnosticOutcome(checks), identity: { ...identity }, checks: checks.map(check => ({ ...check })) };
}
