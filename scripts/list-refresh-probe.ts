#!/usr/bin/env bun
// 大列表可见项分批刷新（refreshViewNode scope="list"）真机验证探针。
// 场景：业务 Debug App feed → 评论区 →「展开N条回复」在列表内插入回复条目（列表级结构变化，
// 超 64 上限、普通分支刷新只能安全拒绝）。流程：
//   1) 强启 App 并预热，固定「精选」feed；打开评论区并采集快照（requestId L）——当前视频评论
//      若无「展开N条回复」则关闭面板切下一个视频重试（≤4 个视频）。采集被启动/就绪/画面护栏
//      或瞬态 Debug V2 失败拒绝时按退避重试；刷新必须沿用「实际成功那次」的 requestId
//      （主进程按键值精确校验活快照，见 main.ts refresh-view-node）；
//   2) 定位列表（含「展开N条回复」的最近 RecyclerView 祖先）与展开控件；
//   3) 点击展开 → refreshViewNode(requestId, 列表 id, "list")：
//      断言刷新成功、无安全拒绝、新回复条目进入；RecyclerView 可替换旧条目实例，
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
  let debuggerPort: number | null = null;
  const metrics: Record<string, unknown> = {};
  let forwardBefore = 0, forwardAfter = 0;
  let passed = false;
  const record = (phase: string, detail: Record<string, unknown>) => {
    metrics[phase] = detail;
    console.log(`[${phase}] ${JSON.stringify(detail)}`);
  };
  const capture = async (requestId: string) => {
    const started = Date.now();
    const invoke = async (id: string) => {
      const reply = await connection!.send("Runtime.evaluate", {
        expression: `window.electronApi.inspectDevice(${JSON.stringify(serial)}, ${JSON.stringify(id)}).then(r => ({ error: r.error, nodeCount: r.nodeCount, root: r.root, inspectionSource: r.inspectionSource }))`,
        awaitPromise: true, returnByValue: true,
      });
      assert.ok(!reply.exceptionDetails, `整页采集 evaluate 异常：${JSON.stringify(reply.exceptionDetails ?? null).slice(0, 240)}`);
      return reply.result?.value as { error: string | null; nodeCount: number; root: UiNode; inspectionSource?: string };
    };
    // 护栏/瞬态读树失败的文案分两类：启动与就绪类（等页面稳定）、读树瞬态类（Debug V2 等）。
    // 注意别用裸「尚未就绪」匹配——它会把「截图尚未就绪」这类画面失败一并吞掉。
    const startups = ["冷启动", "等待页面稳定", "请等待页面就绪", "仍在启动", "未准备好控件树"];
    const transient = ["Debug V2", "读取 View Hierarchy", "返回内容为空", "返回了无效数据", "连接超时", "未读取到 Debug View 节点"];
    const matched = (message: string) => [...startups, ...transient].find((token) => message.includes(token)) ?? null;
    let last: { error: string | null; nodeCount: number; root: UiNode; inspectionSource?: string } | null = null;
    let usedId = requestId;
    for (let attempt = 0; attempt < 3; attempt++) {
      usedId = attempt === 0 ? requestId : `${requestId}-retry${attempt}`;
      const value = await invoke(usedId);
      last = value;
      if (!value.error) return finishCapture(value, usedId, Date.now() - started);
      const token = matched(value.error);
      if (!token || attempt === 2) break;
      console.log(`[retry] 整页采集被拒（命中「${token}」：${value.error.slice(0, 48)}），等 15s 重试（第 ${attempt + 2}/3 次）。`);
      await delay(15000);
    }
    assert.equal(last?.error ?? "整页采集无返回", null, `整页采集失败：${last?.error}`);
    return finishCapture(last!, usedId, Date.now() - started);
  };
  const finishCapture = (value: { error: string | null; nodeCount: number; root: UiNode; inspectionSource?: string }, requestId: string, duration: number) => {
    assert.ok(value.inspectionSource === "debug-view" || value.inspectionSource === "debug-hybrid", `整页采集走了 ${value.inspectionSource ?? "未知"} 回退，不可刷新（requestId=${requestId}）。`);
    if (duration > 45000) console.log(`[warn] 整页采集 ${Math.round(duration / 1000)}s（超过 45s，可能采集退化）。`);
    return { root: value.root, nodeCount: value.nodeCount, duration, inspectionSource: value.inspectionSource!, requestId };
  };

  try {
    const endpointUrl = await awaitEndpoint(endpoint, "debugger startup", 20000);
    const address = new URL(endpointUrl);
    const port = Number(address.port);
    debuggerPort = port;
    connection = await connect(await waitForValue("application window", 30000, () => pageTarget(port).catch(() => null)));
    await waitForElectronApi(connection!, 30000);
    await connection.send("Page.bringToFront");
    forwardBefore = forwardCount();

    // 逐个视频重新定位评论入口；切视频后不能沿用上一条视频的按钮坐标。
    const requestId = `list-probe-${Date.now()}`;
    let feed: Awaited<ReturnType<typeof capture>> | null = null;
    let feedError: string | null = null;
    let entry: UiNode | null = null;
    let panel: Awaited<ReturnType<typeof capture>> | null = null;
    let panelFlat: Array<{ node: UiNode; parent: UiNode | null }> = [];
    let expander: UiNode | null = null;
    let panelOpen = false;
    for (let attempt = 0; attempt < 4 && !expander; attempt++) {
      if (attempt > 0) {
        if (panelOpen) {
          adb("shell", "input", "keyevent", "4");
          await delay(2500);
          panelOpen = false;
        }
        adb("shell", "input", "swipe", "540", "1200", "540", "400", "250");
        await delay(4000);
      }
      try {
        feed = await capture(`${requestId}-feed${attempt}`);
      } catch (error) {
        feedError = (error as Error).message;
        console.log(`[scenario] 第 ${attempt + 1} 个视频采集未成（${feedError.slice(0, 60)}），切下一个视频。`);
        continue;
      }
      const flat = flatten(feed.root);
      entry = flat.map((pair) => pair.node)
        .find((node) => node.clickable && node.visibleToUser && node.bounds && /^评论\d*$/.test((node.contentDesc ?? "").trim())) ?? null;
      if (!entry) {
        const hints = flat.map((pair) => pair.node)
          .filter((node) => node.clickable && node.visibleToUser && /评论/.test((node.text ?? "") + (node.contentDesc ?? ""))).slice(0, 6)
          .map((node) => `${cls(node)}:${JSON.stringify(((node.text ?? "") + "|" + (node.contentDesc ?? "")).trim().slice(0, 20))}`);
        console.log(`[scenario] 第 ${attempt + 1} 个视频未见评论入口（${feed.nodeCount} 节点；线索：${hints.join(" / ") || "无"}），切下一个视频。`);
        continue;
      }
      adb("shell", "input", "tap", String(Math.round((entry.bounds!.left + entry.bounds!.right) / 2)), String(Math.round((entry.bounds!.top + entry.bounds!.bottom) / 2)));
      panelOpen = true;
      await delay(4500);
      try { panel = await capture(`${requestId}-panel${attempt}`); }
      catch (error) {
        console.log(`[scenario] 第 ${attempt + 1} 个视频评论区采集失败（${(error as Error).message.slice(0, 80)}），切下一个视频。`);
        continue;
      }
      panelFlat = flatten(panel.root);
      expander = panelFlat.map((pair) => pair.node).find((node) => /^展开\d+条回复$/.test((node.text ?? "").trim()) && node.visibleToUser && node.bounds) ?? null;
      if (!expander) {
        const hints = panelFlat.map((pair) => pair.node)
          .filter((node) => node.visibleToUser && /回复|评论/.test((node.text ?? "") + (node.contentDesc ?? ""))).slice(0, 6)
          .map((node) => `${cls(node)}:${JSON.stringify(((node.text ?? "") + "|" + (node.contentDesc ?? "")).trim().slice(0, 20))}`);
        console.log(`[scenario] 第 ${attempt + 1} 个视频评论区未见展开控件（${panel.nodeCount} 节点；线索：${hints.join(" / ") || "无"}），换下一个视频。`);
      }
    }
    assert.ok(panel && expander, `四个视频的评论区均未见「展开N条回复」控件（${feedError ?? "该场景在当前 feed 不可得"}）。`);
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
    // 刷新必须沿用面板快照「实际成功那次」的 requestId：主进程按这个键精确校验活快照
    //（liveSessions 存的是最后一次成功采集用的 id，不是我们最初提议的 id）。
    const invokeRefresh = async () => {
      const callStarted = Date.now();
      const reply = await connection!.send("Runtime.evaluate", {
        expression: `window.electronApi.refreshViewNode(${JSON.stringify(panel.requestId)}, ${JSON.stringify(list.id)}, "list").then(r => ({ failures: r.failures, branch: r.branch }))`,
        awaitPromise: true, returnByValue: true,
      });
      assert.ok(!reply.exceptionDetails, `列表分批刷新被拒绝：${JSON.stringify(reply.exceptionDetails ?? null).slice(0, 300)}`);
      const value = reply.result?.value as { failures: Array<{ id: string; message: string }>; branch: UiNode };
      assert.ok(value?.branch, "列表刷新未返回新分支。");
      return { value, callDuration: Date.now() - callStarted };
    };
    // 面板采集刚跑完（70s+），紧随其后的刷新极易吃读树瞬态失败（设备被打满时 dumpsys 段落缺层级）。
    // 与分支探针一致做整体重试：至多 4 次、6s 间隔；身份变化等非瞬态错误立即上抛。
    let refreshed: Awaited<ReturnType<typeof invokeRefresh>> | null = null;
    for (let refreshAttempt = 0; !refreshed; refreshAttempt++) {
      try { refreshed = await invokeRefresh(); }
      catch (first) {
        const message = (first as Error).message ?? "";
        if (refreshAttempt >= 3 || !/Debug V2|返回内容为空|返回了无效数据|读取 View Hierarchy|未读取到 Debug View 节点|连接超时|等待页面稳定|尚未就绪|冷启动/.test(message)) throw first;
        console.log(`[retry] 列表刷新第 ${refreshAttempt + 1} 次未成（${message.slice(0, 60)}），等待 6s 重试。`);
        await delay(6000);
      }
    }
    const duration = Date.now() - started;
    const result = refreshed.value;
    const newChildren = result.branch.children.map((item) => ({ ref: refOf(item), visible: item.visibleToUser, cls: cls(item) }));
    const newRefs = newChildren.map((item) => item.ref).filter(Boolean);
    const added = newRefs.filter((ref) => !oldRefs.includes(ref));
    const missing = oldRefs.filter((ref) => !newRefs.includes(ref));
    // 取证：扩展回复会真实改写列表子项集合。把"新增/丢失"子项的类名与可见性打出来，
    // 便于区分「评论条目身份丢失」（真 bug）与「容器/tab 宿主被 App 换实例」（契约内替换）。
    const describe = (items: typeof oldChildren) => items.map((item) => `${item.cls}${item.visible ? "" : "(不可见)"}`);
    if (missing.length) {
      const missingDetail = oldChildren.filter((item) => missing.includes(item.ref));
      console.log(`[diff] 丢失 ${missing.length} 项：${JSON.stringify(describe(missingDetail).slice(0, 6))}`);
    }
    if (added.length) {
      const addedDetail = newChildren.filter((item) => added.includes(item.ref));
      console.log(`[diff] 新增 ${added.length} 项：${JSON.stringify(describe(addedDetail).slice(0, 6))}`);
    }
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
    // 断言失败也保留真实差异，避免长时间真机采集后只得到一句 missing 错误。
    record("identityDiff", {
      missing: oldChildren.filter((item) => missing.includes(item.ref)),
      added: newChildren.filter((item) => added.includes(item.ref)),
    });
    writeFileSync(join(output, "summary.json"), JSON.stringify(metrics, null, 2));
    // RecyclerView 可重建/复用旧条目实例；旧 ref 消失不等于丢图。
    // 只验真实结构净增长、新树身份唯一、补图无失败，替换细节留在 identityDiff 中供复核。
    assert.ok(newChildren.length > list.children.length && added.length > missing.length,
      `展开后列表未净增长（${list.children.length}→${newChildren.length}，新增 ${added.length}，替换/移除 ${missing.length}）。`);
    assert.equal(new Set(newRefs).size, newRefs.length, "刷新后列表出现重复控件身份。");
    assert.equal(result.failures.length, 0, `刷新失败项：${result.failures.map((item) => item.message).join("；")}`);
    assert.ok(offViewport >= 1, "屏外条目未标注 out-of-viewport。");

    passed = true;
    record("result", { before: list.children.length, after: newChildren.length, added: added.length, durationMs: duration });
  } finally {
    connection?.close();
    if (child.exitCode === null && debuggerPort !== null) {
      try {
        const version = await (await fetch(`http://127.0.0.1:${debuggerPort}/json/version`)).json() as { webSocketDebuggerUrl: string };
        await shutdownProbeElectron(child, await connect(version.webSocketDebuggerUrl));
      } catch { child.kill(); }
    } else if (child.exitCode === null) child.kill();
    forwardAfter = forwardCount();
    record("forwards", { before: forwardBefore, after: forwardAfter });
    writeFileSync(join(output, "summary.json"), JSON.stringify(metrics, null, 2));
    if (passed) {
      assert.ok(forwardAfter <= forwardBefore, "退出后 adb 转发出现残留。");
      console.log(`[pass] 列表可见项分批刷新验证通过（见 ${output}/summary.json）。`);
    }
  }
}
