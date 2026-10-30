import type { DebugMetadata } from "../../shared/debug-metadata";

/** Synthetic values for transport/UI checks; never presented as device evidence. */
export const businessMetadataFixture: DebugMetadata = {
  version: 1, source: "debug-sdk-explicit", status: "captured", groups: [
    { key: "component", label: "组件信息", fields: [
      { key: "name", label: "组件名", type: "string", value: "SampleCard" },
      { key: "owner", label: "归属", type: "string", value: "Inspector 自有样例" },
    ] },
    { key: "state", label: "页面状态", fields: [
      { key: "loading", label: "加载中", type: "boolean", value: false },
      { key: "retryCount", label: "重试次数", type: "number", value: 0 },
      { key: "error", label: "错误信息", type: "string", value: "" },
      { key: "detail", label: "详情", type: "string", value: "长值换行检查_".repeat(40) },
    ] },
  ],
};
