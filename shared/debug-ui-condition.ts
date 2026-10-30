import { z } from "zod";

export const debugConditionState = z.enum(["visible", "absent", "enabled", "disabled"]);
export const debugConditionVisibility = z.literal("partial").optional()
  .describe("仅 visible 的只读断言可显式使用 partial；需要完整 Helper 双帧证据与共同露出区域。默认要求整个控件区域无遮挡；不改变输入权限，也不证明像素内容或播放进度。");

export function refineDebugCondition(value: { state: string; visibility?: "partial" }, context: z.RefinementCtx) {
  if (value.visibility === "partial" && value.state !== "visible")
    context.addIssue({ code: "custom", path: ["visibility"], message: "partial 仅用于 visible 的只读断言。" });
}
