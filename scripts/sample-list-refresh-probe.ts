#!/usr/bin/env bun
// 样例 App「list」模式：scope="list" 可见项分批刷新端到端验证（业务 App 敌对态下的替代验证路径）。
// 场景：24 条目（每条目 4 控件；含 1 个 INVISIBLE 条目）滚动列表 → 点击「条目 0」顶部插入 2 个新条目 →
// refreshViewNode(scope="list")：断言刷新成功、无安全拒绝、新增条目按对象身份进入且文本正确、
// 原条目身份保持、失败项为 0；不可见条目应标注 out-of-viewport（屏外不串图语义）。
// 前置：样例 APK 需为当前 SDK 构建（含会话协议 + list 模式）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UiNode } from "../shared/types";
import { adbForwardCount as forwardCount, awaitEndpoint, shutdownProbeElectron, connectCdp as connect, createWaits, delay, flattenTree as flatten, nodeClass as cls, pageTarget, spawnProbeElectron, subtreeOf, viewRef as refOf, waitForElectronApi } from "./lib/probe-harness";

const project = fileURLToPath(new URL("../", import.meta.url));
const serialArgument = process.argv.find((value) => value.startsWith("--serial="))?.slice("--serial=".length) ?? null;
const requireDevice = process.argv.includes("--require-device");
const appArgument = process.argv.find((value) => value.startsWith("--app="))?.slice("--app=".length) ?? "com.androiduiinspector.sample";
const warmMs = Number(process.argv.find((value) => value.startsWith("--warm-ms="))?.slice("--warm-ms=".length) ?? 8000);

const serial = serialArgument ?? execFileSync("adb", ["get-serialno"], { encoding: "utf8" }).trim();
const devices = execFileSync("adb", ["devices"], { encoding: "utf8" })
  .split(/\r?\n/).slice(1).map((line) => line.split("\t")).filter((cells) => cells.length === 2);
const device = devices.find((cells) => cells[0] === serial && cells[1] === "device");
if (!device) {
  if (requireDevice) throw new Error(`--require-device 需要 ${serial} 在线`);
  console.log(`[skip] 未找到 ${serial}，跳过样例列表刷新探针。`);
} else {
  await runProbe();
}

async function runProbe(): Promise<void> {
  const output = join(project, ".benchmarks", "sample-list-refresh", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(output, { recursive: true });
  console.log(`Sample list refresh probe output: ${output}`);
  const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args]);

  console.log("restarting sample app (mode=list) ...");
  adb("shell", "svc", "power", "stayon", "usb");
  adb("shell", "am", "force-stop", appArgument);
  adb("shell", "am", "start", "-n", `${appArgument}/.MainActivity`, "--es", "mode", "list");
  await delay(warmMs);

  const { child, endpoint } = spawnProbeElectron({ project, userDataDir: join(output, "profile"), logDir: output });
  const { waitForValue } = createWaits(child);

  let connection: Awaited<ReturnType<typeof connect>> | null = null;
  const metrics: Record<string, unknown> = {};
  let forwardBefore = 0, forwardAfter = 0;
  const record = (phase: string, detail: Record<string, unknown>) => {
    metrics[phase] = detail;
    console.log(`[${phase}] ${JSON.stringify(detail)}`);
  };

  try {
    const endpointUrl = await awaitEndpoint(endpoint, "debugger startup", 20000);
    const address = new URL(endpointUrl);
    const debuggerPort = Number(address.port);
    connection = await connect(await waitForValue("application window", 30000, () => pageTarget(debuggerPort).catch(() => null)));
    await waitForElectronApi(connection, 30000);
    forwardBefore = forwardCount();

    const requestId = `sample-list-${Date.now()}`;
    const capture = async (label: string) => {
      const started = Date.now();
      const reply = await connection!.send("Runtime.evaluate", {
        expression: `window.electronApi.inspectDevice(${JSON.stringify(serial)}, ${JSON.stringify(`${requestId}-${label}`)}).then(r => ({ error: r.error, nodeCount: r.nodeCount, root: r.root, inspectionSource: r.inspectionSource }))`,
        awaitPromise: true, returnByValue: true,
      });
      assert.ok(!reply.exceptionDetails, `采集 evaluate 异常：${JSON.stringify(reply.exceptionDetails ?? null).slice(0, 240)}`);
      const value = reply.result?.value as { error: string | null; nodeCount: number; root: UiNode; inspectionSource?: string };
      if (value.error && /冷启动|等待页面稳定|尚未就绪/.test(value.error)) {
        console.log(`[retry] 采集被护栏拒绝（${value.error.slice(0, 40)}），等 10s 重试。`);
        await delay(10000);
        return capture(`${label}-r`);
      }
      assert.equal(value.error, null, `整页采集失败：${value.error}`);
      assert.ok(value.inspectionSource === "debug-view" || value.inspectionSource === "debug-hybrid", `采集走了 ${value.inspectionSource ?? "未知"} 回退，不可刷新。`);
      const duration = Date.now() - started;
      console.log(`[sample-list] 采集（${label}）：${duration}ms、${value.nodeCount} 节点、${value.inspectionSource}`);
      return { root: value.root, nodeCount: value.nodeCount, duration, inspectionSource: value.inspectionSource!, requestId: `${requestId}-${label}` };
    };
    const page = await capture("page");
    const flat = flatten(page.root);
    // 定位列表容器：优先「≥20 个子层且子层（或其后代）文本为 条目 N」，其次调试名匹配
    const looksLikeItem = (node: UiNode) => /^条目 \d+$/.test((node.text ?? "").trim()) || node.children.some((child) => /^条目 \d+$/.test((child.text ?? "").trim()));
    const list = flat.map((pair) => pair.node).find((node) => node.children.filter(looksLikeItem).length >= 20)
      ?? flat.map((pair) => pair.node).find((node) => `${node.text ?? ""}${node.contentDesc ?? ""}`.includes("样例列表容器"));
    assert.ok(list, "未找到样例列表容器（样例 APK 需为含 list 模式的当前构建）。");
    const oldChildren = list.children.map((item) => ({ ref: refOf(item), text: (item.text ?? "").trim(), visible: item.visibleToUser }));
    const oldRefs = oldChildren.map((item) => item.ref).filter(Boolean);
    console.log(`[sample-list] 列表 ${cls(list)} 子层=${list.children.length}（可见 ${oldChildren.filter((item) => item.visible).length}），refs=${oldRefs.length}`);

    const target = flat.map((pair) => pair.node).find((node) => (node.text ?? "").trim() === "条目 0" && node.visibleToUser && node.bounds);
    assert.ok(target, "未找到可点击的「条目 0」");
    // INVISIBLE 条目（进树、visible=false）→ 应被视口筛选排除，刷新后标注 out-of-viewport 并保留旧图
    const invisibleChild = list.children.find((item) => !item.visibleToUser && subtreeOf(item).some((entry) => (entry.text ?? "").trim() === "条目 5"));
    const invisibleRef = invisibleChild ? refOf(invisibleChild) : "";
    assert.ok(invisibleRef, "未找到 INVISIBLE 的「条目 5」容器（样例页应含该节点）");
    console.log(`[sample-list] 不可见条目 ref=${invisibleRef.slice(0, 12)}…`);

    const tapX = Math.round((target.bounds!.left + target.bounds!.right) / 2);
    const tapY = Math.round((target.bounds!.top + target.bounds!.bottom) / 2);
    const addedItemsVisible = () => {
      try {
        adb("shell", "uiautomator", "dump", "/sdcard/sample-list-ui.xml");
        return adb("shell", "cat", "/sdcard/sample-list-ui.xml").includes("新增条目");
      } catch { return false; }
    };
    let scenarioReady = false;
    for (let attempt = 0; attempt < 3 && !scenarioReady; attempt++) {
      console.log(`[sample-list] 点击「条目 0」（第 ${attempt + 1} 次）@ (${tapX},${tapY})`);
      adb("shell", "input", "tap", String(tapX), String(tapY));
      await delay(1500);
      scenarioReady = addedItemsVisible();
      if (!scenarioReady) console.log("[sample-list] 点击后未见新增条目，重试。");
    }
    assert.ok(scenarioReady, "点击「条目 0」三次仍未触发列表新增（场景未建立）。");

    const started = Date.now();
    const refresh = await connection.send("Runtime.evaluate", {
      expression: `window.electronApi.refreshViewNode(${JSON.stringify(page.requestId)}, ${JSON.stringify(list.id)}, "list").then(r => ({ failures: r.failures, branch: r.branch }))`,
      awaitPromise: true, returnByValue: true,
    });
    const duration = Date.now() - started;
    assert.ok(!refresh.exceptionDetails, `列表分批刷新被拒绝：${JSON.stringify(refresh.exceptionDetails ?? null).slice(0, 300)}`);
    const result = refresh.result?.value as { failures: Array<{ id: string; message: string }>; branch: UiNode };
    assert.ok(result?.branch, "列表刷新未返回新分支。");
    const newChildren = result.branch.children.map((item) => ({ node: item, ref: refOf(item), visible: item.visibleToUser }));
    const newRefs = newChildren.map((item) => item.ref).filter(Boolean);
    const textsOf = (node: UiNode) => subtreeOf(node).map((entry) => (entry.text ?? "").trim()).filter(Boolean);
    const addedNodes = newChildren.filter((item) => item.ref && !oldRefs.includes(item.ref));
    const missing = oldRefs.filter((ref) => !newRefs.includes(ref));
    const branchSubtree = subtreeOf(result.branch);
    const captured = branchSubtree.filter((node) => node.layerImageStatus === "captured").length;
    const offViewport = branchSubtree.filter((node) => node.attributes?.["out-of-viewport"] === "true").length;
    const skipped = branchSubtree.filter((node) => node.attributes?.["list-item-skipped"] === "true").length;
    record("refresh", {
      duration, failures: result.failures.length,
      childrenBefore: list.children.length, childrenAfter: newChildren.length,
      addedTexts: addedNodes.map((item) => textsOf(item.node)[0] ?? ""), missingRefs: missing.length,
      captured, offViewport, skipped, subtree: branchSubtree.length,
    });
    console.log(`[sample-list] 刷新：${duration}ms，子层 ${list.children.length} → ${newChildren.length}，新增 ${addedNodes.length}（${addedNodes.map((item) => textsOf(item.node)[0] ?? "").join("、")}），missing=${missing.length}，failures=${result.failures.length}，captured=${captured}，offViewport=${offViewport}，skipped=${skipped}`);

    assert.ok(addedNodes.length >= 2, `未见到新增条目（added=${addedNodes.length}）`);
    assert.ok(addedNodes.some((item) => textsOf(item.node).includes("新增条目 A")) && addedNodes.some((item) => textsOf(item.node).includes("新增条目 B")), "新增条目文本不符");
    const invisibleAfter = newChildren.find((item) => item.ref === invisibleRef);
    assert.ok(invisibleAfter, "不可见条目在新树中丢失");
    const invisibleMarked = invisibleAfter.node.attributes?.["out-of-viewport"] === "true";
    console.log(`[sample-list] 不可见条目刷新后：out-of-viewport=${invisibleMarked}，visible=${invisibleAfter.visible}`);
    assert.ok(invisibleMarked, "不可见条目未按设计标注 out-of-viewport（屏外不串图语义）");
    record("invisible", { ref: invisibleRef, marked: invisibleMarked, visibleAfter: invisibleAfter.visible });
    assert.deepEqual(missing, [], `原条目身份丢失：${missing.slice(0, 3).join(",")}`);
    assert.equal(result.failures.length, 0, `刷新失败项：${result.failures.map((item) => item.message).join("；")}`);
    console.log("[pass] 样例列表 scope=\"list\" 分批刷新验证通过。");

    const version = await (await fetch(`http://127.0.0.1:${debuggerPort}/json/version`)).json() as any;
    const browser = await connect(version.webSocketDebuggerUrl);
    await shutdownProbeElectron(child, browser);
    forwardAfter = forwardCount();
    record("forwards", { before: forwardBefore, after: forwardAfter });
    assert.ok(forwardAfter <= forwardBefore, "退出后 adb 转发出现残留。");
    writeFileSync(join(output, "summary.json"), JSON.stringify(metrics, null, 2));
  } finally {
    connection?.close();
    if (child.exitCode === null) child.kill();
  }
}
