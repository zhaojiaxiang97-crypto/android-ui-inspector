#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createInspectorMcpServer } from "../electron/mcp-server";
import { probeAdb } from "../electron/adb";
import { version } from "../package.json";

const selectors = ["resource-id", "text", "desc", "class"];
const commands: Record<string, { args: number; options: string[]; usage: string }> = {
  doctor: { args: 0, options: [], usage: "检查共享快照和桌面授权状态" },
  devices: { args: 0, options: [], usage: "列出 ADB 设备，不操作手机" },
  attach: { args: 0, options: [], usage: "读取已授权会话；不会自行授权" },
  snapshot: { args: 0, options: [], usage: "读取当前共享快照摘要" },
  capture: { args: 0, options: ["session", "mode"], usage: "--session ID [--mode fast|deep]  实时采集" },
  tree: { args: 0, options: ["snapshot", "node", "depth", "offset", "limit", "format"], usage: "[--depth N] [--node ID] [--format text]  查看层级" },
  find: { args: 1, options: ["snapshot", "by", ...selectors, "visible", "enabled", "clickable", "scrollable", "offset", "limit"], usage: "QUERY [--by all|class|id|text|desc]  搜索控件" },
  attributes: { args: 0, options: ["snapshot", "node", "offset", "attribute-offset", "limit"], usage: "--node ID  查看控件属性、父子关系" },
  screenshot: { args: 0, options: ["snapshot", "node", "out"], usage: "[--node ID] --out FILE  导出屏幕或独立图层" },
  measure: { args: 2, options: ["snapshot"], usage: "FROM_NODE TO_NODE  测量原始布局外框间距" },
  tap: { args: 0, options: ["session", "snapshot", "node"], usage: "--session ID --snapshot ID --node ID  点击一次" },
  scroll: { args: 0, options: ["session", "snapshot", "node", "direction", "distance", "duration-ms"], usage: "--session ID --snapshot ID --node ID --direction down|up|left|right" },
  back: { args: 0, options: ["session", "snapshot"], usage: "--session ID --snapshot ID  返回一次，可能丢弃编辑" },
  wait: { args: 0, options: ["session", ...selectors, "state", "timeout-ms"], usage: "--session ID --text TEXT [--state visible|absent|enabled|disabled]" },
  stop: { args: 0, options: ["session"], usage: "--session ID  撤销自动调试授权" },
};
const globals = ["snapshot-file", "pretty", "help", "version"];
const options = Object.fromEntries([...new Set(["snapshot-file", ...Object.values(commands).flatMap(item => item.options)])]
  .map(name => [name, { type: "string" as const }]));

function snapshotPath(explicit?: string) {
  if (explicit !== undefined) {
    if (!explicit.trim()) throw new Error("--snapshot-file 不能为空。");
    return resolve(explicit);
  }
  const env = process.env.ANDROID_UI_INSPECTOR_MCP_SNAPSHOT;
  if (env) {
    if (!isAbsolute(env)) throw new Error("ANDROID_UI_INSPECTOR_MCP_SNAPSHOT 必须为绝对路径。");
    return env;
  }
  const base = process.platform === "darwin" ? join(homedir(), "Library", "Application Support")
    : process.platform === "win32" ? process.env.APPDATA || join(homedir(), "AppData", "Roaming")
    : process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const candidates = ["android-ui-inspector", "Android UI Inspector"].map(name => join(base, name, "mcp", "current.json"));
  const active = candidates.filter(path => existsSync(path) || existsSync(`${path}.live`));
  if (active.length > 1) throw new Error("发现多个共享目录，请用 --snapshot-file 指定；路径可从桌面‘复制 MCP 配置’获取。");
  return active[0] ?? candidates[0];
}

const errorData = (error: unknown): Record<string, unknown> => ({
  isError: true, message: error instanceof Error ? error.message : String(error),
  ...(error && typeof error === "object" && "details" in error ? error.details as Record<string, unknown> : {}),
});

async function main() {
  const { values, positionals, tokens } = parseArgs({ options: {
    ...options, pretty: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
  }, allowPositionals: true, tokens: true });
  const [command, ...args] = positionals;
  const flags: Record<string, string | boolean | undefined> = values;
  const str = (key: string) => typeof flags[key] === "string" ? flags[key] as string : undefined;
  const required = (key: string) => { const value = str(key); if (!value?.trim()) throw new Error(`缺少 --${key}；请查看 --help。`); return value; };
  const number = (key: string) => {
    const value = str(key);
    if (value === undefined) return undefined;
    if (!/^-?\d+(\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) throw new Error(`--${key} 必须为有限数字。`);
    return Number(value);
  };
  const boolean = (key: string) => {
    const value = str(key);
    if (value === undefined) return undefined;
    if (value !== "true" && value !== "false") throw new Error(`--${key} 只接受 true 或 false。`);
    return value === "true";
  };
  const output = (data: unknown) => process.stdout.write(`${JSON.stringify(data, null, values.pretty ? 2 : undefined)}\n`);
  if (values.version) { output({ name: "android-ui", version }); return; }
  if (values.help || !command || command === "help") {
    process.stdout.write(`Android UI Inspector CLI ${version}\n\n用法：android-ui COMMAND [OPTIONS]\n\n${Object.entries(commands).map(([name, spec]) => `  ${name.padEnd(12)} ${spec.usage}`).join("\n")}\n
通用：--pretty（缩进 JSON） --snapshot-file PATH（覆盖默认共享目录） -h/--help -v/--version
只读命令使用已共享快照，不会隐式采集；--snapshot ID 可固定版本。
tree：--depth 0–200（默认 200），--offset 0–20000，--limit 1–20000（默认 1000）。
find / attributes：--offset N --limit 1–50；attributes 另有 --attribute-offset N。
find：--resource-id/--text/--desc/--class 精确匹配；--visible/--enabled/--clickable/--scrollable true|false。
scroll：--distance 0.1–0.8 --duration-ms 150–1000；wait：--timeout-ms 1000–30000。
先在桌面‘文件 → MCP’共享快照或开启自动调试。attach 仅读取授权，不保存或延长会话。
tap / scroll / back 必须显式传入最新 session 和 snapshot；失败或结果未知时不要盲目重试。
stdout 为结果 JSON（tree --format text 除外）；失败输出 stderr JSON，退出码 1。\n`);
    return;
  }
  const spec = commands[command];
  if (!spec) throw new Error(`未知命令：${command}。请查看 --help。`);
  if (args.length !== spec.args) throw new Error(`${command} 需要 ${spec.args} 个位置参数：${spec.usage}`);
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new Error(`--${token.name} 重复，未执行。`);
    seen.add(token.name);
    if (!globals.includes(token.name) && !spec.options.includes(token.name)) throw new Error(`${command} 不支持 --${token.name}。`);
  }
  if (command === "devices") {
    const probe = await probeAdb();
    output(probe);
    if (probe.error) process.exitCode = 1;
    return;
  }

  // Reuse the same validated tools in-process: no subprocess, second service or duplicate device logic.
  const path = snapshotPath(str("snapshot-file"));
  const server = createInspectorMcpServer(path);
  const client = new Client({ name: "android-ui-cli", version });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  const controller = new AbortController();
  const interrupt = () => { process.exitCode = 130; controller.abort(new Error("命令已取消；操作可能已发出，不要盲目重试。")); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await server.connect(remote);
    await client.connect(local);
    const call = async (name: string, input: Record<string, unknown> = {}) => {
      try {
        const result = await client.callTool({ name, arguments: input }, undefined, { timeout: name === "get_debug_session" ? 5000 : 135_000, signal: controller.signal }) as CallToolResult;
        if (result.isError) {
          const details = result.structuredContent ?? { message: result.content.filter(item => item.type === "text").map(item => item.text).join("\n") };
          throw Object.assign(new Error(String(details.message ?? "操作失败。")), { details });
        }
        return result;
      } catch (error) {
        // A lost response is not proof that input was never sent. Preserve the desktop's state when available.
        if (["tap_node", "scroll_node", "press_back"].includes(name)) {
          throw Object.assign(new Error("操作失败；结果未知时不要盲目重试。"), { details: { dispatchState: "unknown", ...errorData(error) } });
        }
        throw error;
      }
    };
    const data = async (name: string, input: Record<string, unknown> = {}) => (await call(name, input)).structuredContent!;
    const current = async () => str("snapshot") ?? (await data("get_snapshot")).snapshotId;
    const selector = Object.fromEntries([["resourceId", str("resource-id")], ["text", str("text")], ["contentDesc", str("desc")], ["className", str("class")]].filter(([, value]) => value !== undefined));
    switch (command) {
      case "doctor": {
        const check = async (name: string): Promise<Record<string, unknown> & { ready: boolean }> => {
          try { return { ready: true, ...await data(name) }; } catch (error) { return { ready: false, ...errorData(error) }; }
        };
        const shared = await check("get_snapshot"), live = await check("get_debug_session");
        const ready = shared.ready || (live.ready && live.active === true);
        output({ ready, snapshotFile: path, shared, live, hint: "只读需共享快照；实时采集和操作需在桌面开启自动调试。" });
        if (!ready) process.exitCode = 1;
        break;
      }
      case "attach": {
        const state = await data("get_debug_session");
        if (!state.active) throw new Error("会话已停止，请在桌面重新开启自动调试。");
        output(state); break;
      }
      case "snapshot": output(await data("get_snapshot")); break;
      case "tree": {
        const depth = number("depth") ?? 200, offset = number("offset") ?? 0, limit = number("limit") ?? 1000;
        if (!Number.isInteger(limit) || limit < 1 || limit > 20_000) throw new Error("--limit 必须为 1–20000 的整数。");
        const format = str("format") ?? "json";
        if (!["json", "text"].includes(format)) throw new Error("--format 只接受 json 或 text。");
        const snapshotId = await current();
        const items: Array<Record<string, unknown>> = [];
        let page: Record<string, unknown>;
        do {
          page = await data("get_tree", { snapshotId, nodeId: str("node"), depth, offset: offset + items.length, limit: Math.min(500, limit - items.length) });
          items.push(...page.items as Array<Record<string, unknown>>);
        } while (page.nextOffset !== null && items.length < limit);
        if (format === "json") output({ ...page, items });
        else {
          // App text is untrusted; escape terminal controls (including ANSI / bidi), keeping each node on one line.
          const safe = (value: unknown) => String(value ?? "").replace(/[\p{Cc}\p{Cf}]/gu, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
          process.stdout.write(`${items.map(item => `${"  ".repeat(Number(item.depth))}${safe(item.id)}  ${safe(item.className)}  ${safe(item.name)}`).join("\n")}\n`);
          process.stderr.write(`snapshotId=${snapshotId}  ${items.length}/${page.total}  depthLimited=${page.depthLimited}  nextOffset=${page.nextOffset}\n`);
        }
        break;
      }
      case "find": output(await data("search_nodes", { snapshotId: await current(), query: args[0], by: str("by"),
        selector: Object.keys(selector).length ? selector : undefined, offset: number("offset"), limit: number("limit"),
        ...Object.fromEntries(["visible", "enabled", "clickable", "scrollable"].map(key => [key, boolean(key)])) })); break;
      case "attributes": output(await data("get_node", { snapshotId: await current(), nodeId: required("node"),
        offset: number("offset"), attributeOffset: number("attribute-offset"), limit: number("limit") })); break;
      case "measure": output(await data("measure_nodes", { snapshotId: await current(), fromNodeId: args[0], toNodeId: args[1] })); break;
      case "screenshot": {
        const out = resolve(required("out"));
        const result = await call("get_image", { snapshotId: await current(), nodeId: str("node") });
        const image = result.content.find(item => item.type === "image" || item.type === "resource");
        const mime = image?.type === "image" ? image.mimeType : image?.type === "resource" ? image.resource.mimeType : null;
        const extensions: Record<string, string[]> = { "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"], "image/webp": [".webp"], "image/svg+xml": [".svg"] };
        if (!mime || !extensions[mime]?.includes(extname(out).toLowerCase())) throw new Error(`图片格式是 ${mime ?? "未知"}，请使用对应扩展名：${extensions[mime ?? ""]?.join(" / ") ?? "无"}。`);
        const bytes = image?.type === "image" ? Buffer.from(image.data, "base64")
          : image?.type === "resource" && "text" in image.resource ? Buffer.from(image.resource.text) : null;
        if (!bytes?.length) throw new Error("没有可导出的图像。");
        writeFileSync(out, bytes, { flag: "wx", mode: 0o600 });
        output({ ...result.structuredContent, path: out, mimeType: mime, bytes: bytes.length });
        break;
      }
      default: {
        const sessionId = required("session");
        const input: Record<string, unknown> = { sessionId };
        if (["tap", "scroll", "back"].includes(command)) input.snapshotId = required("snapshot");
        if (["tap", "scroll"].includes(command)) input.nodeId = required("node");
        if (command === "capture") input.mode = str("mode");
        if (command === "scroll") Object.assign(input, { direction: required("direction"), distance: number("distance"), durationMs: number("duration-ms") });
        if (command === "wait") Object.assign(input, { selector, state: str("state"), timeoutMs: number("timeout-ms") });
        const tool = { capture: "capture_ui", tap: "tap_node", scroll: "scroll_node", back: "press_back", wait: "wait_for_ui", stop: "stop_debug_session" }[command]!;
        output(await data(tool, input));
      }
    }
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await client.close();
    await server.close();
  }
}

void main().catch(error => { process.stderr.write(`${JSON.stringify(errorData(error))}\n`); process.exitCode ||= 1; });
