import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createAccessibilityHelperSession } from "../electron/capture/helper-session";
import { readDisplayFrame } from "../electron/device/screen";
import type { UiNode } from "../shared/types";
import type { HelperTargetProbeRequest } from "../shared/helper-target-probe";

export function probeTargetFromNode(node: UiNode): HelperTargetProbeRequest["target"] {
  if (!node.className || !node.bounds || !node.clickable || !node.enabled || !node.visibleToUser)
    throw new Error("预检目标不是可见且可用的点击控件。");
  const { left, top, right, bottom } = node.bounds;
  return { ...(node.resourceId ? { resourceId: node.resourceId } : {}), className: node.className,
    ...(node.text !== null ? { text: node.text } : {}), ...(node.contentDesc !== null ? { contentDesc: node.contentDesc } : {}),
    bounds: { left, top, right, bottom } };
}

/** Explicit local diagnostic only. Authorization is checked before capture, before probe and before accepting a result. */
async function main() {
  const { values } = parseArgs({ options: { cli: { type: "string" }, session: { type: "string" }, serial: { type: "string" },
    package: { type: "string" }, "resource-id": { type: "string" }, desc: { type: "string" }, class: { type: "string" },
    adb: { type: "string", default: "adb" }, help: { type: "boolean", short: "h" } }, strict: true, allowPositionals: false });
  if (values.help) {
    console.log("用法：bun scripts/helper-target-probe.ts --cli PATH --session UUID --serial SERIAL --package APP (--resource-id ID | --desc TEXT) [--class CLASS] [--adb PATH]\n需要 ANDROID_UI_INSPECTOR_HELPER_TOKEN_FILE。只做一次完整快照和一次 1000ms 目标预检，不发送点击、滚动或返回，不自动重试。结果只含固定状态和计时，不输出界面正文或令牌。"); return;
  }
  const { cli, session, serial, package: packageName, adb } = values;
  if (!cli || !z.uuid().safeParse(session).success || !serial || !/^[\w.-]+$/.test(serial)
    || !packageName || !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)
    || Boolean(values["resource-id"]) === Boolean(values.desc) || values.desc !== undefined && !values.desc.trim())
    throw new Error("预检参数无效，请查看 --help。");
  const authorized = () => {
    const result = spawnSync(process.env.NODE_BINARY ?? "node", [cli, "attach"], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
    let current;
    try { current = JSON.parse(result.stdout); } catch { throw new Error("未找到可用桌面授权。"); }
    if (result.status !== 0 || !current.active || current.busy || current.id !== session || current.serial !== serial
      || current.packageName !== packageName || !(Date.parse(current.expiresAt) > Date.now())) throw new Error("桌面授权已失效、忙碌或目标不符。");
  };
  authorized();
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(45000)]);
  const helper = createAccessibilityHelperSession({ sessionId: session!, serial, signal });
  try {
    const frame = await readDisplayFrame(adb, serial);
    if (!frame) throw new Error("无法读取屏幕尺寸。");
    const started = performance.now();
    const observation = await helper.read(adb, packageName, frame, signal);
    const observationMs = performance.now() - started;
    const matches: UiNode[] = [];
    const walk = (node: UiNode | null) => {
      if (!node) return;
      if ((values["resource-id"] ? node.resourceId === values["resource-id"] : node.contentDesc === values.desc)
        && (values.class === undefined || node.className === values.class)) matches.push(node);
      node.children.forEach(walk);
    };
    walk(observation.root);
    if (matches.length !== 1) throw new Error("预检目标未唯一匹配。");
    const target = probeTargetFromNode(matches[0]);
    authorized(); signal.throwIfAborted();
    const scanStarted = performance.now();
    const reply = await helper.probeTarget!(adb, packageName, frame, observation.helperObservation, target, signal);
    const probeWallMs = performance.now() - scanStarted;
    authorized(); signal.throwIfAborted();
    console.log(JSON.stringify({ observationMs: Math.round(observationMs), nodeCount: observation.nodeCount,
      probeWallMs: Math.round(probeWallMs), helperDeadlineMs: 1000, reply }));
  } finally { lifetime.abort(); await helper.close(); }
}
if (import.meta.main) await main().catch(error => {
  console.error(JSON.stringify({ isError: true, message: error instanceof Error ? error.message : "只读预检失败。" }));
  process.exitCode = 1;
});
