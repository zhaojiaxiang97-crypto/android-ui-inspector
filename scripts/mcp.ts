import { isAbsolute } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createInspectorMcpServer } from "../electron/mcp-server";

async function main() {
  const path = process.env.ANDROID_UI_INSPECTOR_MCP_SNAPSHOT;
  if (!path || !isAbsolute(path)) throw new Error("请从软件‘复制 MCP 配置’获取配置；ANDROID_UI_INSPECTOR_MCP_SNAPSHOT 必须为绝对路径。");
  const server = createInspectorMcpServer(path);
  await server.connect(new StdioServerTransport());
}

void main().catch(error => { console.error(error instanceof Error ? error.message : "MCP 启动失败"); process.exitCode = 1; });
