#!/usr/bin/env bun
// 大列表可见项分批刷新（refreshViewNode scope="list"）真机验证探针。
// 场景：业务 Debug App feed → 评论区 →「展开N条回复」在列表内插入回复条目（列表级结构变化，
// 超 64 上限、普通分支刷新只能安全拒绝）。流程：
//   1) 强启 App 并预热，固定「精选」feed；打开评论区并采集快照（requestId L）——当前视频评论
//      若无「展开N条回复」则关闭面板切下一个视频重试（≤4 个视频）；
//   2) 定位列表（含「展开N条回复」的最近 RecyclerView 祖先）与展开控件；
//   3) 点击展开 → refreshViewNode(requestId, 列表 id, "list")：
//      断言刷新成功、无安全拒绝、新回复条目按对象身份进入、原条目身份保持、
//      可见条目取得独立画面、屏外条目标注 out-of-viewport；
//   4) 优雅退出后确认 adb 转发无残留；分批明细取自主进程日志 [list-refresh]。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UiNode } from "../shared/types";
import { adbForwardCount as forwardCount, awaitEndpoint, shutdownProbeElectron, connectCdp as connect, createWaits, delay, flattenTree as flatten, nodeClass as cls, pageTarget, spawnProbeElectron, subtreeOf, viewRef as refOf, waitForElectronApi, type CdpCall } from "./lib/probe-harness";

const project = fileURLToPath(new URL("../", import.meta.url));
const serialArgument = process.argv.find((value) => value.startsWith("--serial="))?.slice("--serial=".length) ?? null;
const requireDevice = process.argv.includes("--require-device");
const appArgument = process.argv.find((value) => value.startsWith("--app="))?.slice("--app=".length) ?? "com.smile.gifmaker";
const warmMs = Number(process.argv.find((value) => value.startsWith("--warm-ms="))?.slice("--warm-ms=".length) ?? 80000);
if (!Number.isSafeInteger(warmMs) || warmMs < 5000 || warmMs > 600000) throw new Error("--warm-ms 取 5000..600000");

const serial = serialArgument ?? execFileSync("adb", ["get-serialno"], { encoding: "utf8" }).trim();
const devices = execFileSync("adb", ["devices"], { encoding: "utf8" })
  .split(/\r?\n/).slice(1).map((line) => line.split("\t")).filter((cells) => cells.length === 2);
const device = devices.find((cells) => cells[0] === serial && cells[1] === "device");
if (!device) {
  if (requireDevice) throw new Error(`--require-device 需要 ${serial} 在线`);
  console.log(`[skip] 未找到 ${serial}，跳过列表分批刷新探针。`);
} else {
  await runProbe();
}

async function runProbe(): Promise<void> {
  const output = join(project, ".benchmarks", "list-refresh-probe", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(output, { recursive: true });
  console.log(`List refresh probe output: ${output}`);
  const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args]);

  console.log("restarting app ...");
  adb("shell", "svc", "power", "stayon", "usb");
  adb("shell", "am", "force-stop", appArgument);
  adb("shell", "am", "start", "-n", `${appArgument}/com.yxcorp.gifshow.HomeActivity`);
  await delay(warmMs);
  adb("shell", "input", "tap", "324", "2312"); // 底部栏第 2 个 tab：精选
  await delay(4000);

  const { child, endpoint } = spawnProbeElectron({ project, userDataDir: join(output, "profile"), logDir: output });
  const { waitForValue } = createWaits(child);

  let connection = null as CdpCall | null;
  const metrics: Record<string, unknown> = {};
  let forwardBefore = 0, forwardAfter = 0;
  const record = (phase: string, detail: Record<string, unknown>) => {
    metrics[phase] = detail;
    console.log(`[${phase}] ${JSON.stringify(detail)}`);
  };
  const capture = async (requestId: string) => {
    const started = Date.now();
    const reply = await connection!.send("Runtime.evaluate", {
      expression: `window.electronApi.inspectDevice(${JSON.stringify(serial)}, ${JSON.stringify(requestId)}).then(r => ({ error: r.error, nodeCount: r.nodeCount, root: r.root, inspectionSource: r.inspectionSource }))`,
      awaitPromise: true, returnByValue: true,
    });
    assert.ok(!reply.exceptionDetails, `整页采集 evaluate 异常：${JSON.stringify(reply.exceptionDetails ?? null).slice(0, 240)}`);
    const value = reply.result?.value as { error: string | null; nodeCount: number; root: UiNode; inspectionSource?: string };
    if (value.error && (value.error.includes("冷启动") || value.error.includes("等待页面稳定") || value.error.includes("尚未就绪") || value.error.includes("请等待页面就绪"))) {
      console.log(`[retry] 整页采集被护栏拒绝（${value.error.slice(0, 40)}），等待 25s 重试一次。`);
      await delay(25000);
      const again = await connection!.send("Runtime.evaluate", {
        expression: `window.electronApi.inspectDevice(${JSON.stringify(serial)}, ${JSON.stringify(`${requestId}-retry`)}).then(r => ({ error: r.error, nodeCount: r.nodeCount, root: r.root, inspectionSource: r.inspectionSource }))`,
        awaitPromise: true, returnByValue: true,
      });
      const retried = again.result?.value as { error: string | null; nodeCount: number; root: UiNode; inspectionSource?: string };
      assert.equal(retried.error, null, `整页采集失败：${retried.error}`);
      return finishCapture(retried, requestId, Date.now() - started);
    }
    assert.equal(value.error, null, `整页采集失败：${value.error}`);
    return finishCapture(value, requestId, Date.now() - started);
  };
  const finishCapture = (value: { error: string | null; nodeCount: number; root: UiNode; inspectionSource?: string }, requestId: string, duration: number) => {
    assert.ok(value.inspectionSource === "debug-view" || value.inspectionSource === "debug-hybrid", `整页采集走了 ${value.inspectionSource ?? "未知"} 回退，不可刷新（requestId=${requestId}）。`);
    if (duration > 45000) console.log(`[warn] 整页采集 ${Math.round(duration / 1000)}s（超过 45s，可能采集退化）。`);
    return { root: value.root, nodeCount: value.nodeCount, duration, inspectionSource: value.inspectionSource! };
  };

  try {
    const endpointUrl = await awaitEndpoint(endpoint, "debugger startup", 20000);
    const address = new URL(endpointUrl);
    const debuggerPort = Number(address.port);
    connection = await connect(await waitForValue("application window", 30000, () => pageTarget(debuggerPort).catch(() => null)));
    await waitForElectronApi(connection!, 30000);
    await connection.send("Page.bringToFront");
    forwardBefore = forwardCount();

    // 1) 采集首页快照：重视频会把 App 拖入 CPU 燃烧态（采集 50-90s），换到轻视频再试（≤3 次）。
    const requestId = `list-probe-${Date.now()}`;
    let feed: Awaited<ReturnType<typeof capture>> | null = null;
    let feedError: string | null = null;
    for (let attempt = 0; attempt < 3 && !feed; attempt++) {
      if (attempt > 0) {
        adb("shell", "input", "swipe", "540", "1200", "540", "400", "250");
        await delay(4000);
      }
      try {
        feed = await capture(`${requestId}-feed${attempt}`);
      } catch (error) {
        feedError = (error as Error).message;
        console.log(`[scenario] 第 ${attempt + 1} 个视频采集未成（${feedError.slice(0, 60)}），切下一个视频。`);
      }
    }
    assert.ok(feed, `三个视频均无法采集：${feedError ?? "未知"}`);
    const feedFlat = flatten(feed.root);
    const entry = feedFlat.map((pair) => pair.node).find((node) => node.clickable && node.visibleToUser && /^评论\d+$/.test((node.contentDesc ?? "").trim()) && node.bounds);
    assert.ok(entry, "首页未找到评论入口（该卡片可能不是标准视频卡片）。");
    const entryX = Math.round((entry.bounds!.left + entry.bounds!.right) / 2);
    const entryY = Math.round((entry.bounds!.top + entry.bounds!.bottom) / 2);
    // 2) 打开评论区并定位「展开N条回复」：视频评论可能没有回复——关闭面板换下一个视频重试（≤4 个视频）。
    let panel: Awaited<ReturnType<typeof capture>> | null = null;
    let panelFlat: Array<{ node: UiNode; parent: UiNode | null }> = [];
    let expander: UiNode | null = null;
    for (let attempt = 0; attempt < 4 && !expander; attempt++) {
      if (attempt > 0) {
        adb("shell", "input", "keyevent", "4"); // 关闭评论面板
        await delay(2500);
        adb("shell", "input", "swipe", "540", "1200", "540", "400", "250"); // 下一个视频
        await delay(4000);
      }
      adb("shell", "input", "tap", String(entryX), String(entryY));
      await delay(3500);
      panel = await capture(`${requestId}-panel${attempt}`);
      panelFlat = flatten(panel.root);
      expander = panelFlat.map((pair) => pair.node).find((node) => /^展开\d+条回复$/.test((node.text ?? "").trim()) && node.visibleToUser && node.bounds) ?? null;
      if (!expander) {
        const hints = panelFlat.map((pair) => pair.node)
          .filter((node) => node.visibleToUser && /回复|评论/.test((node.text ?? "") + (node.contentDesc ?? ""))).slice(0, 6)
          .map((node) => `${cls(node)}:${JSON.stringify(((node.text ?? "") + "|" + (node.contentDesc ?? "")).trim().slice(0, 20))}`);
        console.log(`[scenario] 第 ${attempt + 1} 个视频评论区未见展开控件（${panel.nodeCount} 节点；线索：${hints.join(" / ") || "无"}），换下一个视频。`);
      }
    }
    assert.ok(panel && expander, "四个视频的评论区均未见「展开N条回复」控件（该场景在当前 feed 不可得）。");
    // 定位展开控件所属列表（最近 RecyclerView 祖先）
    let list: UiNode | null = panelFlat.find((pair) => pair.node === expander)?.parent ?? null;
    while (list && !/RecyclerView/.test(list.className ?? "")) list = panelFlat.find((pair) => pair.node === list)?.parent ?? null;
    assert.ok(list && list.attributes?.["view-ref"], "未能定位「展开回复」所属 RecyclerView 列表。");
    const oldChildren = list.children.map((item) => ({ ref: refOf(item), visible: item.visibleToUser, cls: cls(item) }));
    const oldRefs = oldChildren.map((item) => item.ref).filter(Boolean);
    record("list", {
      listClass: cls(list), listId: list.id, children: list.children.length,
      visibleChildren: oldChildren.filter((item) => item.visible).length,
      expanderText: (expander.text ?? "").trim(), captureMs: panel.duration, source: panel.inspectionSource,
    });

    // 3) 展开回复 → 列表分批刷新
    adb("shell", "input", "tap", String(Math.round((expander.bounds!.left + expander.bounds!.right) / 2)), String(Math.round((expander.bounds!.top + expander.bounds!.bottom) / 2)));
    await delay(4000);
    const started = Date.now();
    const refresh = await connection.send("Runtime.evaluate", {
      expression: `window.electronApi.refreshViewNode(${JSON.stringify(`${requestId}-panel`)}, ${JSON.stringify(list.id)}, "list").then(r => ({ failures: r.failures, branch: r.branch }))`,
      awaitPromise: true, returnByValue: true,
    });
    const duration = Date.now() - started;
    assert.ok(!refresh.exceptionDetails, `列表分批刷新被拒绝：${JSON.stringify(refresh.exceptionDetails ?? null).slice(0, 300)}`);
    const result = refresh.result?.value as { failures: Array<{ id: string; message: string }>; branch: UiNode };
    assert.ok(result?.branch, "列表刷新未返回新分支。");
    const newChildren = result.branch.children.map((item) => ({ ref: refOf(item), visible: item.visibleToUser, cls: cls(item) }));
    const newRefs = newChildren.map((item) => item.ref).filter(Boolean);
    const added = newRefs.filter((ref) => !oldRefs.includes(ref));
    const missing = oldRefs.filter((ref) => !newRefs.includes(ref));
    const branchSubtree = subtreeOf(result.branch);
    const captured = branchSubtree.filter((node) => node.layerImageStatus === "captured").length;
    const offViewport = branchSubtree.filter((node) => node.attributes?.["out-of-viewport"] === "true").length;
    const skipped = branchSubtree.filter((node) => node.attributes?.["list-item-skipped"] === "true").length;
    record("refresh", {
      duration, failures: result.failures.length,
      childrenBefore: list.children.length, childrenAfter: newChildren.length,
      visibleAfter: newChildren.filter((item) => item.visible).length,
      addedRefs: added.length, missingRefs: missing.length,
      captured, offViewport, skipped,
      subtree: branchSubtree.length,
    });
    // 合并语义断言：新增条目（回复）进入、原评论条目身份保持、无串图
    assert.ok(added.length >= 1, `展开后未见新增条目（added=${added.length}），列表刷新未体现结构变化。`);
    assert.deepEqual(missing, [], `原条目身份丢失：${missing.slice(0, 3).join(",")}`);
    assert.equal(result.failures.length, 0, `刷新失败项：${result.failures.map((item) => item.message).join("；")}`);
    assert.ok(offViewport >= 1, "屏外条目未标注 out-of-viewport。");

    // 4) 优雅退出并核对转发
    const version = await (await fetch(`http://127.0.0.1:${debuggerPort}/json/version`)).json() as any;
    const browser = await connect(version.webSocketDebuggerUrl);
    await shutdownProbeElectron(child, browser);
    forwardAfter = forwardCount();
    record("forwards", { before: forwardBefore, after: forwardAfter });
    assert.ok(forwardAfter <= forwardBefore, "退出后 adb 转发出现残留。");
    writeFileSync(join(output, "summary.json"), JSON.stringify(metrics, null, 2));
    console.log(`[pass] 列表可见项分批刷新验证通过（${list.children.length} → ${newChildren.length} 条目，新增 ${added.length}，${duration}ms）。`);
  } finally {
    connection?.close();
    if (child.exitCode === null) child.kill();
  }
}
