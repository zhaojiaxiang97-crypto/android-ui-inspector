import { z } from "zod";
import type { UiNode } from "./types";

const selectorText = z.string().min(1).max(512);
export const debugSelector = z.object({
  resourceId: selectorText.optional(), text: selectorText.optional(), contentDesc: selectorText.optional(), className: selectorText.optional(),
}).strict().refine(value => Object.values(value).some(item => item !== undefined), "至少指定一个精确匹配条件");

export function matchesDebugSelector(node: UiNode, selector: z.infer<typeof debugSelector>) {
  return Object.entries(selector).every(([key, value]) => value === undefined || node[key as keyof UiNode] === value);
}
