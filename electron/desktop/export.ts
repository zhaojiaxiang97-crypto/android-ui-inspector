import { app, clipboard, ClipboardItem, dialog } from "electron";
import type { BrowserWindow, SaveDialogOptions } from "electron";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExportFormat, ExportSnapshotRequest, ExportSnapshotResult } from "../../shared/types";
import { MAX_SNAPSHOT_FILE_BYTES, parseSnapshotFile } from "../../shared/snapshot-file";
import { validateSnapshotImages } from "./snapshot-file";
import { outputNodeImage } from "./node-image";

export function createNodeImageClipboardItem(bytes: Buffer) {
  return new ClipboardItem({ "image/png": new Blob([new Uint8Array(bytes)], { type: "image/png" }) });
}

export function exportNodeImage(input: unknown, mainWindow: BrowserWindow) {
  const ensureOpen = () => { if (mainWindow.isDestroyed()) throw new Error("原窗口已关闭，图片输出已停止。"); };
  return outputNodeImage(input, {
    choosePath: async name => {
      ensureOpen();
      const result = await dialog.showSaveDialog(mainWindow, { title: "导出控件图片", defaultPath: join(app.getPath("documents"), name),
        filters: [{ name: "PNG 图片", extensions: ["png"] }], properties: ["createDirectory", "showOverwriteConfirmation"] });
      return result.canceled ? null : result.filePath ?? null;
    },
    write: async (path, bytes) => { ensureOpen(); await writeFile(path, bytes); },
    copy: async bytes => {
      ensureOpen();
      await clipboard.write([createNodeImageClipboardItem(bytes)]);
    },
  });
}

function isExportFormat(value: unknown): value is ExportFormat {
  return value === "snapshot" || value === "json" || value === "xml" || value === "png";
}

function isExportSnapshotRequest(value: unknown): value is ExportSnapshotRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<ExportSnapshotRequest>;
  return isExportFormat(request.format) && typeof request.data === "string" && typeof request.defaultFileName === "string";
}

function safeDefaultFileName(name: string, format: ExportFormat) {
  const sanitized = basename(name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim();
  return sanitized || `android-ui-inspector.${format}`;
}

export async function exportSnapshot(input: unknown, mainWindow: BrowserWindow | null): Promise<ExportSnapshotResult> {
  if (!isExportSnapshotRequest(input)) {
    return { canceled: false, filePath: null, error: "导出参数无效。" };
  }
  if (Buffer.byteLength(input.data, "utf8") > MAX_SNAPSHOT_FILE_BYTES) {
    return { canceled: false, filePath: null, error: "导出内容过大，已拒绝写入。" };
  }

  if (input.format === "snapshot") {
    try {
      const file = parseSnapshotFile(JSON.parse(input.data));
      if (file.legacy) throw new Error("完整快照导出不能使用旧版控件树格式。");
      await validateSnapshotImages(file.snapshot);
    } catch (error) { return { canceled: false, filePath: null, error: error instanceof Error ? error.message : "完整快照格式无效。" }; }
  }
  const extension = input.format === "snapshot" ? "json" : input.format;
  const saveOptions: SaveDialogOptions = {
    title: input.format === "snapshot" ? "导出完整快照" : "导出快照",
    defaultPath: join(app.getPath("documents"), safeDefaultFileName(input.defaultFileName, extension)),
    filters: input.format === "snapshot" ? [{ name: "完整快照 JSON", extensions: ["json"] }] : [
      { name: "JSON 文件", extensions: ["json"] },
      { name: "XML 文件", extensions: ["xml"] },
      { name: "PNG 图片", extensions: ["png"] },
    ],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  };
  const saveResult = mainWindow
    ? await dialog.showSaveDialog(mainWindow, saveOptions)
    : await dialog.showSaveDialog(saveOptions);

  if (saveResult.canceled || !saveResult.filePath) {
    return { canceled: true, filePath: null, error: null };
  }

  try {
    const payload = input.format === "png"
      ? (() => {
          const prefix = "data:image/png;base64,";
          if (!input.data.startsWith(prefix)) throw new Error("PNG 快照格式无效。");
          return Buffer.from(input.data.slice(prefix.length), "base64");
        })()
      : Buffer.from(input.data, "utf8");

    if (payload.length === 0) throw new Error(`无法导出空的 ${extension.toUpperCase()} 内容。`);
    await writeFile(saveResult.filePath, payload);
    return { canceled: false, filePath: saveResult.filePath, error: null };
  } catch (error) {
    return {
      canceled: false,
      filePath: null,
      error: error instanceof Error ? error.message : "导出文件失败。",
    };
  }
}
