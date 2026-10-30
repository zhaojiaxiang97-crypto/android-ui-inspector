import { z } from "zod";
import { debugTaskCondition, debugTaskDefinition } from "./debug-task";

export const MAX_DEBUG_TASK_TEMPLATES = 30;
export const MAX_DEBUG_TASK_TEMPLATE_BYTES = 512 * 1024;
export const MAX_DEBUG_TASK_FRAGMENTS = 60;
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

export const debugTaskStage = debugTaskDefinition.shape.checkpoints.unwrap().element.superRefine((stage, context) => {
  if (new Set(stage.conditions.map(item => item.id)).size !== stage.conditions.length)
    context.addIssue({ code: "custom", message: "阶段内的条件编号必须唯一。" });
  if (new TextEncoder().encode(JSON.stringify(stage)).length > 12000)
    context.addIssue({ code: "custom", message: "阶段片段超过12KB。" });
});
const fragmentMetadata = { id: debugTaskTemplateId, name: templateName, createdAt: date, updatedAt: date };
export const debugTaskFragment = z.discriminatedUnion("kind", [
  z.object({ ...fragmentMetadata, kind: z.literal("condition"), condition: debugTaskCondition }).strict(),
  z.object({ ...fragmentMetadata, kind: z.literal("stage"), stage: debugTaskStage }).strict(),
]);
export const debugTaskFragmentSaveInput = z.discriminatedUnion("kind", [
  z.object({ name: templateName, kind: z.literal("condition"), condition: debugTaskCondition }).strict(),
  z.object({ name: templateName, kind: z.literal("stage"), stage: debugTaskStage }).strict(),
]);

export const debugTaskTemplateFile = z.object({
  version: z.literal(1),
  templates: z.array(debugTaskTemplate).max(MAX_DEBUG_TASK_TEMPLATES),
  fragments: z.array(debugTaskFragment).max(MAX_DEBUG_TASK_FRAGMENTS).default([]),
}).strict().superRefine((file, context) => {
  if (new Set(file.templates.map(item => item.id)).size !== file.templates.length
    || new Set(file.templates.map(item => item.name)).size !== file.templates.length) {
    context.addIssue({ code: "custom", message: "模板编号和名称必须分别唯一。" });
  }
  if (new Set(file.fragments.map(item => item.id)).size !== file.fragments.length
    || new Set(file.fragments.map(item => item.name)).size !== file.fragments.length)
    context.addIssue({ code: "custom", message: "片段编号和名称必须分别唯一。" });
  if (new TextEncoder().encode(JSON.stringify(file)).length > MAX_DEBUG_TASK_TEMPLATE_BYTES) {
    context.addIssue({ code: "custom", message: "模板文件超过512KB。" });
  }
});

export type DebugTaskTemplate = z.infer<typeof debugTaskTemplate>;
export type DebugTaskTemplateSaveInput = z.infer<typeof debugTaskTemplateSaveInput>;
export type DebugTaskTemplatesResult = { templates: DebugTaskTemplate[]; error: string | null };
export type DebugTaskStage = z.infer<typeof debugTaskStage>;
export type DebugTaskFragment = z.infer<typeof debugTaskFragment>;
export type DebugTaskFragmentSaveInput = z.infer<typeof debugTaskFragmentSaveInput>;
export type DebugTaskFragmentsResult = { fragments: DebugTaskFragment[]; error: string | null };
export type DebugTaskTemplateImportResult = {
  canceled: boolean; filePath: string | null; templates: DebugTaskTemplate[]; fragments: DebugTaskFragment[];
  imported: { templates: number; fragments: number }; skipped: { templates: string[]; fragments: string[] }; error: string | null;
};
export type DebugTaskTemplateExportResult = {
  canceled: boolean; filePath: string | null; templateCount: number; fragmentCount: number; error: string | null;
};
