import { z } from "zod";
import { debugTaskDefinition } from "./debug-task";

export const MAX_DEBUG_TASK_TEMPLATES = 30;
export const MAX_DEBUG_TASK_TEMPLATE_BYTES = 512 * 1024;
export const debugTaskTemplateId = z.string().uuid();
const templateName = z.string().trim().min(1).max(128);
const date = z.string().datetime({ offset: true });

export const debugTaskTemplate = z.object({
  id: debugTaskTemplateId,
  name: templateName,
  createdAt: date,
  updatedAt: date,
  definition: debugTaskDefinition,
}).strict();

export const debugTaskTemplateSaveInput = z.object({
  id: debugTaskTemplateId.optional(),
  name: templateName,
  definition: debugTaskDefinition,
}).strict();

export const debugTaskTemplateFile = z.object({
  version: z.literal(1),
  templates: z.array(debugTaskTemplate).max(MAX_DEBUG_TASK_TEMPLATES),
}).strict().superRefine((file, context) => {
  if (new Set(file.templates.map(item => item.id)).size !== file.templates.length
    || new Set(file.templates.map(item => item.name)).size !== file.templates.length) {
    context.addIssue({ code: "custom", message: "模板编号和名称必须分别唯一。" });
  }
  if (new TextEncoder().encode(JSON.stringify(file)).length > MAX_DEBUG_TASK_TEMPLATE_BYTES) {
    context.addIssue({ code: "custom", message: "模板文件超过512KB。" });
  }
});

export type DebugTaskTemplate = z.infer<typeof debugTaskTemplate>;
export type DebugTaskTemplateSaveInput = z.infer<typeof debugTaskTemplateSaveInput>;
export type DebugTaskTemplatesResult = { templates: DebugTaskTemplate[]; error: string | null };
