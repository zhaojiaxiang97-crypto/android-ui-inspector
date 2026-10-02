#!/usr/bin/env bun
// 分支刷新（refreshViewNode scope="branch"）真实结构变化验证探针。
// 场景：业务 Debug App feed 页点击视频暂停——"播放视频"图标控件加入树；恢复播放后该控件被移除。
// 流程（主方向=新增，对应计划验收"真实新增子层无需整页重采即可进入桌面快照"）：
//   1) 强启 App 并预热，固定到「精选」feed；采集播放态快照（无图标），
//      目标分支 = 图标父容器（按类名 TouchDelegateFrameLayout + 点击点 bounds 定位，≤64 可见）；
//   2) 奇数轮点击暂停（图标进树）→ refreshViewNode(scope=branch)：断言新图标按对象身份进入、
//      取得独立画面、原分支成员身份保持、可见控件画面全部刷新；
//   3) 偶数轮点击恢复播放（图标移除）→ 再次刷新：断言删除合并；恢复后的缓冲谷
//      （wrapper 暂不可见）触发"无可见控件"安全拒绝时等待 5s 重试；
//   4) 最后一轮无操作刷新验证稳态一致；
//   5) 切到下一张卡片后刷新，断言分支身份变化被安全拒绝；
//   6) 退出应用后确认 adb 转发无残留。
// 已知限制：暂停/刚交互态下 SDK 独立画面 capture 可能长时间挂起（外部测量 24.8s~90s，
// desktop 会话截止 60s 报「会话调用超时：capture」），因此本探针所有刷新都发生在播放态；
// 暂停态仅用于采集快照，且对采集时间打点。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UiNode } from "../shared/types";
import { adbForwardCount as forwardCount, awaitEndpoint, shutdownProbeElectron, connectCdp as connect, contentOf, createWaits, delay, flattenTree as flatten, nodeClass as cls, pageTarget, spawnProbeElectron, subtreeOf, viewRef as refOf, visibleCount, waitForElectronApi, type CdpCall } from "./lib/probe-harness";

const project = fileURLToPath(new URL("../", import.meta.url));
const serialArgument = process.argv.find((value) => value.startsWith("--serial="))?.slice("--serial=".length) ?? null;
const requireDevice = process.argv.includes("--require-device");
const assetArgument = process.argv.find((value) => value.startsWith("--play-icon-desc="))?.slice("--play-icon-desc=".length) ?? "播放视频";
const appArgument = process.argv.find((value) => value.startsWith("--app="))?.slice("--app=".length) ?? "com.smile.gifmaker";
const branchClass = process.argv.find((value) => value.startsWith("--branch-class="))?.slice("--branch-class=".length) ?? "TouchDelegateFrameLayout";
const tapPoint = (() => {
  const argument = process.argv.find((value) => value.startsWith("--tap="))?.slice("--tap=".length) ?? null;
  const match = argument?.match(/^(\d+)[x,](\d+)$/i);
  return { x: match ? Number(match[1]) : 540, y: match ? Number(match[2]) : 700 };
})();
const warmMs = Number(process.argv.find((value) => value.startsWith("--warm-ms="))?.slice("--warm-ms=".length) ?? 80000);
if (!Number.isSafeInteger(warmMs) || warmMs < 5000 || warmMs > 600000) throw new Error("--warm-ms 取 5000..600000");
const refreshRounds = Number(process.argv.find((value) => value.startsWith("--rounds="))?.slice("--rounds=".length) ?? 2);
if (!Number.isSafeInteger(refreshRounds) || refreshRounds < 1 || refreshRounds > 4) throw new Error("--rounds 取 1..4");

const serial = serialArgument ?? execFileSync("adb", ["get-serialno"], { encoding: "utf8" }).trim();
const devices = execFileSync("adb", ["devices"], { encoding: "utf8" })
  .split(/\r?\n/).slice(1).map((line) => line.split("\t")).filter((cells) => cells.length === 2);
const device = devices.find((cells) => cells[0] === serial && cells[1] === "device");
if (!device) {
  if (requireDevice) throw new Error(`--require-device 需要 ${serial} 在线`);
  console.log(`[skip] 未找到 ${serial}，跳过分支刷新探针。`);
} else {
  await runProbe();
}

async function runProbe(): Promise<void> {
  const output = join(project, ".benchmarks", "branch-refresh-probe", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(output, { recursive: true });
  console.log(`Branch refresh probe output: ${output}`);
  const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args]);
  const tap = () => adb("shell", "input", "tap", String(tapPoint.x), String(tapPoint.y));

  // 确定性起点：强制重启业务 App 并预热，然后固定导航到「精选」feed tab
  // （重启后停留在上次 tab，可能落在「我的」等页面，无法提供沉浸视频与暂停图标）。
  console.log("restarting app ...");
  adb("shell", "svc", "power", "stayon", "usb"); // 探针期间保持亮屏（仅 USB 连接时生效，拔线自清）
  adb("shell", "am", "force-stop", appArgument);
  adb("shell", "am", "start", "-n", `${appArgument}/com.yxcorp.gifshow.HomeActivity`);
  await delay(warmMs);
  adb("shell", "input", "tap", "324", "2312"); // 底部栏第 2 个 tab：精选
  await delay(4000);

  const { child, endpoint } = spawnProbeElectron({ project, userDataDir: join(output, "profile"), logDir: output });
  const { waitForValue } = createWaits(child);
  // 图标候选优先取叶子节点：feed 卡片级容器也带「播放视频」可达性文案，不能作为目标。
  const findIconEntry = (root: UiNode) => {
    const entries = flatten(root).filter((entry) => contentOf(entry.node).includes(assetArgument) && entry.parent && entry.node.visibleToUser);
    return entries.find((entry) => entry.node.children.length === 0) ?? null;
  };
  const assertValidReply = (reply: any, label: string) => {
    assert.ok(!reply.exceptionDetails, `${label} evaluate 异常：${JSON.stringify(reply.exceptionDetails ?? null).slice(0, 240)}`);
    return reply.result?.value as any;
  };

  let connection = null as CdpCall | null;
  const phases: Record<string, unknown>[] = [];
  const metrics = { captureBms: 0, refreshes: [] as Record<string, unknown>[], rejection: null as string | null, forwardBefore: 0, forwardAfter: 0 };
  const record = (phase: string, detail: Record<string, unknown>) => {
    phases.push({ phase, ...detail });
    console.log(`[${phase}] ${JSON.stringify(detail)}`);
  };
  const captureOnce = async (requestId: string) => {
    const started = Date.now();
    const reply = await connection!.send("Runtime.evaluate", {
      expression: `window.electronApi.inspectDevice(${JSON.stringify(serial)}, ${JSON.stringify(requestId)}).then(r => ({ requestId: r.requestId, error: r.error, nodeCount: r.nodeCount, root: r.root, inspectionSource: r.inspectionSource }))`,
      awaitPromise: true, returnByValue: true,
    });
    const value = assertValidReply(reply, "整页采集") as { requestId: string; error: string | null; nodeCount: number; root: UiNode; inspectionSource?: string };
    const duration = Date.now() - started;
    if (duration > 45000) console.log(`[warn] 整页采集 ${Math.round(duration / 1000)}s（超过 45s，可能采集退化）。`);
    // 调试树瞬态读取失败时流水线会静默回退 uiautomator：快但快照不支持分支刷新。
    if (!value.error && value.inspectionSource !== "debug-view" && value.inspectionSource !== "debug-hybrid")
      console.log(`[warn] 整页采集走了 ${value.inspectionSource ?? "未知"} 来源（不可分支刷新）。`);
    return value.error
      ? { error: value.error, root: null as UiNode | null, nodeCount: 0, duration, inspectionSource: value.inspectionSource ?? "unknown" }
      : { error: null as string | null, root: value.root, nodeCount: value.nodeCount, duration, inspectionSource: value.inspectionSource ?? "unknown" };
  };
  // 冷启动护栏（55/90 秒）与「等待页面稳定」类错误：等待后允许重试一次。
  const capture = async (requestId: string) => {
    let result = await captureOnce(requestId);
    if (result.error && (result.error.includes("冷启动") || result.error.includes("等待页面稳定") || result.error.includes("尚未就绪") || result.error.includes("请等待页面就绪"))) {
      console.log(`[retry] 整页采集被护栏拒绝（${result.error.slice(0, 40)}），等待 25s 后重试一次。`);
      await delay(25000);
      const warm = Date.now();
      result = await captureOnce(`${requestId}-retry`);
      console.log(`[retry] 第二次采集耗时 ${Date.now() - warm}ms`);
    }
    assert.equal(result.error, null, `整页采集失败：${result.error}`);
    return { root: result.root!, nodeCount: result.nodeCount, duration: result.duration, inspectionSource: result.inspectionSource };
  };

  try {
    const endpointUrl = await awaitEndpoint(endpoint, "debugger startup", 20000);
    const address = new URL(endpointUrl);
    const debuggerPort = Number(address.port);
    connection = await connect(await waitForValue("application window", 30000, () => pageTarget(debuggerPort).catch(() => null)));
    await waitForElectronApi(connection!, 30000);
    await connection.send("Page.bringToFront");

    let deviceCheck = null as { result?: { value?: unknown }; exceptionDetails?: unknown } | null;
    let deviceKnown = true;
    for (let attempt = 0; attempt < 5; attempt++) {
      deviceCheck = await connection.send("Runtime.evaluate", {
        expression: `window.electronApi && window.electronApi.probeAdb ? window.electronApi.probeAdb().then((r) => r.devices.map((d) => d.serial).includes(${JSON.stringify(serial)})) : null`,
        awaitPromise: true, returnByValue: true,
      }).catch(() => null);
      const value = deviceCheck?.result?.value;
      if (value === true) { deviceKnown = true; break; }
      deviceKnown = false;
      await delay(1500);
    }
    if (!deviceKnown)
      throw new Error(`桌面端无法访问 ${serial}：${JSON.stringify(deviceCheck ?? null).slice(0, 400)}`);
    metrics.forwardBefore = forwardCount();

    // 场景建立 + 全轮验证：安全拒绝（身份/层级/无可见控件）多为 feed 前进后 RecyclerView
    // 复用同一对象（ref 不变但已挪出屏）所致，属产品正确防线；切到下一张视频重建场景再试。
    const SAFE_REJECT = /未找到包含点击点的|两次点击后仍未发现|三次采集均含|没有可刷新的可见控件|控件身份、位置或层级已变化|分支在刷新期间变化|分支在补图期间移动|App、进程或窗口已变化|App 或进程已变化/;
    type Scenario = { requestIdB: string; parent: UiNode; parentVisible: number };
    const runScenario = async (): Promise<Scenario> => {
      // 目标快照 = 播放态（无图标）。恢复播放后的缓冲谷期间图标同样缺席，可作快照；
      // 若首采含图标（当前为暂停态），恢复播放后重采一次。
      const requestIdB = `branch-probe-b-${Date.now()}`;
      let playing: Awaited<ReturnType<typeof capture>> | null = null;
      for (let settle = 0; settle < 3; settle++) {
        const candidate = await capture(requestIdB);
        // uiautomator 回退不可刷新：不动播放状态，等 2s 直接重采。
        if (candidate.inspectionSource !== "debug-view" && candidate.inspectionSource !== "debug-hybrid") {
          console.log(`[state] 第 ${settle + 1} 采走了 ${candidate.inspectionSource} 回退，等待 2s 重采。`);
          await delay(2000);
          continue;
        }
        if (!findIconEntry(candidate.root)) { playing = candidate; break; }
        console.log(`[state] 第 ${settle + 1} 采含图标（当前为暂停态），点击恢复播放后重采。`);
        tap();
        await delay(6000); // 慢态下点击可能延迟生效，多等一些再验
      }
      if (!playing) throw new Error(`三次采集均无法建立可刷新的播放态快照。`);
      metrics.captureBms = playing.duration;
      // 目标分支 = 暂停浮层图标的父容器（播放态无图标，按类名 + 点击点 bounds 取最小包含者）。
      const wrapperCandidates = flatten(playing.root).filter((item) => cls(item.node) === branchClass
        && item.node.attributes?.["view-ref"] && item.node.bounds
        && item.node.bounds.left <= tapPoint.x && item.node.bounds.right >= tapPoint.x
        && item.node.bounds.top <= tapPoint.y && item.node.bounds.bottom >= tapPoint.y);
      const chosen = wrapperCandidates.sort((a, b) => subtreeOf(a.node).length - subtreeOf(b.node).length)[0];
      if (!chosen) throw new Error(`播放态快照中未找到包含点击点的 ${branchClass} 目标分支。`);
      const parent = chosen.node;
      const parentSubtree = subtreeOf(parent);
      const parentVisible = visibleCount(parentSubtree);
      assert.ok(parentVisible >= 1 && parentVisible <= 64, `目标分支可见控件 ${parentVisible} 个，不满足 1..64 的分支刷新上限。`);
      const baselineRefs = parentSubtree.map(refOf).filter(Boolean);
      record("target", {
        parent: cls(parent), parentRef: refOf(parent).slice(0, 14), parentVisible, parentTotal: parentSubtree.length,
        bounds: [parent.bounds?.left, parent.bounds?.top, parent.bounds?.right, parent.bounds?.bottom].every((value) => typeof value === "number")
          ? [parent.bounds!.left, parent.bounds!.top, parent.bounds!.right, parent.bounds!.bottom] : null,
        captureBms: metrics.captureBms, source: playing.inspectionSource,
        treeSource: playing.root?.attributes?.["sdk-tree-source"] ?? "-",
      });

      // 交替验证真实增删（主方向=新增，对应计划验收「真实新增子层无需整页重采即可进入桌面快照」）：
      // 奇数轮暂停（活树新增图标，验证按对象身份进入与补图），偶数轮恢复播放（图标移除，验证删除合并）；
      // 最后一轮无操作验证稳态一致。
      const iconRefsSeen: string[] = [];
      for (let round = 1; round <= refreshRounds + 1; round++) {
        const steadyState = round > refreshRounds;
        const expectIcons = steadyState ? (refreshRounds % 2 === 1 ? 1 : 0) : (round % 2 === 1 ? 1 : 0);
        if (!steadyState) {
          tap(); // 奇数轮=暂停（图标进树），偶数轮=恢复播放（图标移除）
          // 暂停淡入约 2 秒内完成；恢复播放需等缓冲谷过去（wrapper 期间不可见，会触发"无可见控件"安全拒绝）
          await delay(round % 2 === 1 ? 2500 : 4000);
        }
        const started = Date.now();
        const invokeRefresh = async () => {
          const reply = await connection!.send("Runtime.evaluate", {
            expression: `window.electronApi.refreshViewNode(${JSON.stringify(requestIdB)}, ${JSON.stringify(parent.id)}, "branch").then(r => ({ failures: r.failures, branch: r.branch }))`,
            awaitPromise: true, returnByValue: true,
          });
          return assertValidReply(reply, "分支刷新") as { failures: Array<{ id: string; message: string }>; branch: UiNode };
        };
        let value: { failures: Array<{ id: string; message: string }>; branch: UiNode } | null = null;
        for (let refreshAttempt = 0; !value; refreshAttempt++) {
          try {
            value = await invokeRefresh();
          } catch (first) {
            const message = (first as Error).message ?? "";
            // 可重试两类：读树瞬态失败（VURT 编码竞态/空回包）；恢复播放后的缓冲期（wrapper 暂不可见，
            // 缓冲期间不消耗播放时长，等待即可）。最多重试两次，其余（身份变化等）立即上抛。
            if (refreshAttempt >= 2) throw first;
            // 会话超时（SDK capture 挂起）不在此重试：每次要耗约 2×60 秒，交给场景级重试切换新视频。
            const transient = /Debug V2|返回内容为空|返回了无效数据|树读取失败|冷启动|等待页面稳定|尚未就绪|读取 View Hierarchy/.test(message);
            const buffering = /没有可刷新的可见控件/.test(message);
            if (transient || buffering) {
              console.log(`[retry] 分支刷新第 ${refreshAttempt + 1} 次未成（${transient ? "瞬态读树" : "缓冲期无可见控件"}，${message.slice(0, 50)}），等待 5s 重试。`);
              await delay(5000);
            } else throw first;
          }
        }
        const duration = Date.now() - started;
        const branchSubtree = subtreeOf(value.branch);
        const branchRefs = branchSubtree.map(refOf).filter(Boolean);
        assert.ok(branchSubtree.length >= parentSubtree.length, `刷新后的分支节点数 ${branchSubtree.length} 少于快照 ${parentSubtree.length}。`);
        // 合并语义：快照成员必须全部保留（缺失即丢身份）；活树新增属于合法合并内容，仅记录不判失败。
        const missing = baselineRefs.filter((ref) => !branchRefs.includes(ref));
        assert.deepEqual(missing, [], `旧子层身份未保留：${missing.slice(0, 3).join(",") || "-"}`);
        const adopted = branchSubtree.filter((node) => !baselineRefs.includes(refOf(node)) && refOf(node) && !contentOf(node).includes(assetArgument));
        const icons = branchSubtree.filter((node) => contentOf(node).includes(assetArgument) && node !== parent);
        assert.equal(icons.length, expectIcons, `第 ${round} 轮预期 ${expectIcons} 个图标，实际 ${icons.length} 个。`);
        if (icons[0]) iconRefsSeen.push(refOf(icons[0]));
        if (expectIcons && icons[0]) assert.equal(icons[0].layerImageStatus, "captured", "新进树的图标未取得独立画面。");
      const unrefreshed = branchSubtree.filter((node) => node.visibleToUser && refOf(node) && node.layerImageStatus !== "captured" && node.layerImageStatus !== "unavailable");
        assert.equal(unrefreshed.length, 0, `分支 ${visibleCount(branchSubtree)} 个可见控件中 ${unrefreshed.length} 个画面未刷新：${cls(unrefreshed[0]) ?? "?"}（${unrefreshed[0]?.layerImageStatus}）`);
        const detail = {
          round: steadyState ? "steady" : round, duration, failures: value.failures.length,
          branchRefs: branchRefs.length, branchVisible: visibleCount(branchSubtree), expectIcons,
          adopted: adopted.map((node) => `${cls(node)}:${contentOf(node).slice(0, 10) || "?"}`),
          iconNewObject: icons[0] ? !iconRefsSeen.includes(refOf(icons[0])) : false,
          captured: branchSubtree.filter((node) => node.layerImageStatus === "captured").length,
          skipDraw: branchSubtree.filter((node) => node.layerImageStatus === "unavailable").length,
        };
        metrics.refreshes.push(detail);
        assert.equal(value.failures.length, 0, `刷新失败项：${value.failures.map((item) => item.message).join("；")}`);
        record(steadyState ? "steady" : `remove#${round}`, detail);
      }
      return { requestIdB, parent, parentVisible };
    };
    let scenario: Scenario | null = null;
    let safeRejects = 0;
    for (let attempt = 1; attempt <= 4 && !scenario; attempt++) {
      try {
        scenario = await runScenario();
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (attempt < 4 && SAFE_REJECT.test(message)) {
          safeRejects++;
          const reason = message.match(/Error: ([^"\\]+)/)?.[1] ?? message.slice(0, 60);
          console.log(`[scenario] 第 ${attempt} 次尝试未成（${reason}），切到下一张视频重建场景。`);
          adb("shell", "input", "swipe", "540", "1200", "540", "400", "250");
          await delay(4000);
        } else throw error;
      }
    }
    if (!scenario) throw new Error("场景重建 4 次均未成功，探针终止。");
    const { requestIdB, parent, parentVisible } = scenario;

    // 安全拒绝：切到下一张卡片再刷新，分支身份必然已变化。
    adb("shell", "input", "swipe", "540", "1200", "540", "400", "250");
    await delay(1800);
    let wasRejected = false;
    let rejection = "";
    try {
      await connection.send("Runtime.evaluate", {
        expression: `window.electronApi.refreshViewNode(${JSON.stringify(requestIdB)}, ${JSON.stringify(parent.id)}, "branch").then(r => ({ failures: r.failures.length, branch: Boolean(r.branch) }))`,
        awaitPromise: true, returnByValue: true,
      });
    } catch (error) {
      wasRejected = true;
      rejection = (error as Error).message;
      metrics.rejection = rejection;
    }
    assert.ok(wasRejected, "切页后分支刷新应当被安全拒绝。");
    record("reject", { message: rejection.slice(0, 140) });

    // 优雅退出（Browser.close）触发 before-quit 清理会话转发；回包可能缺失，由 socket 关闭兜底。
    const version = await (await fetch(`http://127.0.0.1:${debuggerPort}/json/version`)).json() as any;
    const browser = await connect(version.webSocketDebuggerUrl);
    await shutdownProbeElectron(child, browser);
    metrics.forwardAfter = forwardCount();
    record("forwards", { before: metrics.forwardBefore, after: metrics.forwardAfter });
    assert.ok(metrics.forwardAfter <= metrics.forwardBefore, "退出后 adb 转发出现残留。");

    const summary = { serial, parent: cls(parent) ?? "", parentVisible, rounds: refreshRounds, safeRejects, rejection: metrics.rejection, captureBms: metrics.captureBms, refreshes: metrics.refreshes, phases };
    writeFileSync(join(output, "summary.json"), JSON.stringify(summary, null, 2));
    console.log(`[pass] 分支刷新真实结构变化验证通过（rounds=${refreshRounds}, safeRejects=${safeRejects}, parentVisible=${parentVisible}, branch=${cls(parent)}）。`);
  } finally {
    connection?.close();
    if (child.exitCode === null) child.kill();
  }
}
