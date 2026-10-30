import type { DebugMetadata, DebugTreeNode } from "../../shared/debug-metadata";
export const structuredMetadataFixture: DebugMetadata = {
  version: 2, source: "debug-sdk-explicit", status: "captured", groups: [{ key: "state", label: "页面状态", fields: [
    { key: "absent", label: "未获取", type: "null", value: null },
    { key: "detail", label: "业务详情", type: "tree", value: [
      { key: "request", label: "请求", type: "null", value: null, children: [
        { key: "loading", label: "加载中", type: "boolean", value: false, children: [] },
        { key: "retries", label: "重试次数", type: "number", value: 0, children: [] },
        { key: "error", label: "错误信息", type: "string", value: "", children: [] },
        { key: "payload", label: "内容", type: "string", value: "  完整业务信息_".repeat(24) + "中😀\n\"\\尾部", children: [] },
      ] },
      { key: "cache", label: "缓存", type: "string", value: "ok", children: [
        { key: "loading", label: "缓存加载中", type: "boolean", value: true, children: [] },
      ] },
    ] },
  ] }],
};
export function debugTreeDepth(depth: number): DebugTreeNode[] {
  let nodes: DebugTreeNode[] = [];
  for (let i = depth; i > 0; i--) nodes = [{ key: `level${i}`, label: `层级 ${i}`, type: "null", value: null, children: nodes }];
  return nodes;
}
