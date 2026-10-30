import { z } from "zod";
import type { ImportTestReportResult } from "./test-report";

export const DEBUG_REPORT_EXPORT_VERSION = "inspector-debug-export-1" as const;
const token = z.string().min(1).max(128).regex(/^[\w-]+$/);
export const debugReportExportRequestSchema = z.object({
  requestId: token,
  sourceId: token,
  reportSha256: z.string().regex(/^[a-f0-9]{64}$/),
  stepIds: z.union([z.literal("all"), z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(100)
    .refine(ids => new Set(ids).size === ids.length, "步骤编号重复")]),
  includeTrees: z.boolean(),
  includeScreenshots: z.boolean(),
  includeLogs: z.boolean(),
}).strict();

export type DebugReportExportRequest = z.infer<typeof debugReportExportRequestSchema>;
export type DebugReportExportResult = {
  canceled: boolean;
  directory: string | null;
  error: string | null;
  stepCount: number;
  warnings: string[];
};
// Main binds this opaque token to the importing window and original report hash.
export type DebugExportHandle = string;
export type DebugReportExportImportResult = ImportTestReportResult & { exportSourceId?: DebugExportHandle };
export type DebugReportExportApi = {
  exportDebugReportEvidence: (request: DebugReportExportRequest) => Promise<DebugReportExportResult>;
  cancelDebugReportExport: (requestId: string) => Promise<void>;
};
