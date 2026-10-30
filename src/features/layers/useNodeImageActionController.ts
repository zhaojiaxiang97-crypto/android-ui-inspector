import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { QmlGroupImage, UiNode } from "../../../shared/types";
import { nodeImageExportPlan, type NodeImageScope } from "../../../shared/node-image-export";
import { nodeDisplayLabel, nodeShortClass } from "../../../shared/tree-utils";
import { indexTree } from "../../../shared/visible-tree";
import type { NodeImagePreviewState } from "../../components/NodeImagePreview";
import { prepareNodeImageExport } from "./prepareNodeImageExport";
import { prepareNodeImagePreview } from "./prepareNodeImagePreview";

export type NodeImageActionRequest = {
  root: UiNode; node: UiNode; groupImage?: QmlGroupImage | null; sessionKey?: string | number;
  scope: NodeImageScope; action: "preview" | "copy" | "save"; key?: string | number;
};
export type NodeImageActionController = {
  busy: boolean; status: string | null; title: string | null; preview: NodeImagePreviewState | null;
  run: (request: NodeImageActionRequest) => void; cancel: () => void;
  outputPreview: (state: NodeImagePreviewState, action: "copy" | "save") => void;
};

export function useNodeImageActionController({ root, node, sessionKey, groupImage }: {
  root: UiNode | null; node?: UiNode | null; sessionKey?: string | number; groupImage?: QmlGroupImage | null;
}): NodeImageActionController {
  const [busy, setBusy] = useState(false), [status, setStatus] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null), [preview, setPreview] = useState<NodeImagePreviewState | null>(null);
  const pending = useRef<AbortController | null>(null), previewOpen = useRef(false);
  const preparedPreview = useRef<{ state: NodeImagePreviewState; fileName: string; valid: () => boolean } | null>(null);
  const activeRequest = useRef<NodeImageActionRequest | null>(null);
  const lastKey = useRef<string | number | undefined>(undefined);
  const treeIndex = useMemo(() => root ? indexTree(root) : null, [root]);
  const current = useRef({ root, node, sessionKey, treeIndex, groupImage });
  current.current = { root, node, sessionKey, treeIndex, groupImage };
  const cancel = useCallback(() => {
    pending.current?.abort(); pending.current = null; previewOpen.current = false; preparedPreview.current = null; activeRequest.current = null;
    setBusy(false); setStatus(null); setTitle(null); setPreview(null);
  }, []);
  useLayoutEffect(() => {
    cancel(); lastKey.current = undefined;
    return () => { pending.current?.abort(); pending.current = null; previewOpen.current = false; preparedPreview.current = null; activeRequest.current = null; };
  }, [root, node, sessionKey, cancel]);
  useLayoutEffect(() => {
    const request = activeRequest.current;
    if (request?.scope === "branch" && groupImage !== undefined && (request.groupImage ?? null) !== groupImage) cancel();
  }, [groupImage, cancel]);
  const run = useCallback((request: NodeImageActionRequest) => {
    const owner = current.current;
    if (!owner.root || request.root !== owner.root || request.sessionKey !== owner.sessionKey
      || (owner.node && request.node !== owner.node)
      || (request.scope === "branch" && owner.groupImage !== undefined && (request.groupImage ?? null) !== owner.groupImage)
      || owner.treeIndex?.get(request.node.id)?.node !== request.node
      || (request.key !== undefined && request.key === lastKey.current)) return;
    if (pending.current || previewOpen.current) return;
    const plan = nodeImageExportPlan(request.node, request.scope, request.groupImage ?? null);
    if (plan.kind === "unavailable") return;
    const send = window.electronApi?.outputNodeImage;
    if (request.action !== "preview" && !send) return;
    lastKey.current = request.key;
    const controller = new AbortController(); pending.current = controller; activeRequest.current = request;
    const valid = () => current.current.root === owner.root && current.current.node === owner.node
      && current.current.sessionKey === owner.sessionKey
      && (request.scope !== "branch" || current.current.groupImage === undefined || current.current.groupImage === (request.groupImage ?? null))
      && current.current.treeIndex?.get(request.node.id)?.node === request.node;
    const active = () => pending.current === controller && !controller.signal.aborted && valid();
    const name = `${nodeDisplayLabel(request.node)} · ${nodeShortClass(request.node)}`;
    const fileName = `${plan.fileTag}-${nodeShortClass(request.node)}-${request.node.id}`.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 140);
    setBusy(true); setTitle(name);
    if (request.action === "preview") {
      previewOpen.current = true; setStatus(null);
      const description: NodeImagePreviewState = { title: name, source: plan.label, detail: plan.detail, sourceKind: plan.kind, image: null, error: null };
      setPreview(description);
      void (async () => {
        try {
          const image = await prepareNodeImagePreview(request.node, plan, controller.signal);
          if (active()) {
            const state = { ...description, image };
            preparedPreview.current = { state, fileName: `${fileName}.png`, valid }; setPreview(state);
          }
        } catch (error) {
          if (active()) setPreview({ ...description, error: error instanceof Error ? error.message : "图片预览失败。" });
        } finally {
          if (active()) { pending.current = null; setBusy(false); }
        }
      })();
    } else {
      setStatus(request.action === "save" ? "正在准备 PNG…" : "正在准备复制…");
      void (async () => {
        try {
          const image = await prepareNodeImageExport(request.node, plan, controller.signal);
          if (!active()) return;
          const result = await send!({ action: request.action as "copy" | "save", ...image, defaultFileName: `${fileName}.png` });
          if (active()) setStatus(result.canceled ? null : result.error || (request.action === "copy"
            ? `已复制图片 · ${plan.label}` : `已保存 · ${plan.label}：${result.filePath}`));
        } catch (error) {
          if (active()) setStatus(error instanceof Error ? error.message : "输出控件图片失败。");
        } finally {
          if (active()) { pending.current = null; setBusy(false); }
        }
      })();
    }
  }, []);
  const outputPreview = useCallback((state: NodeImagePreviewState, action: "copy" | "save") => {
    const prepared = preparedPreview.current, send = window.electronApi?.outputNodeImage, image = state.image;
    if (!prepared || prepared.state !== state || !image || state.error || !prepared.valid()
      || !previewOpen.current || pending.current || !send) return;
    const controller = new AbortController(); pending.current = controller;
    const active = () => pending.current === controller && !controller.signal.aborted
      && preparedPreview.current === prepared && previewOpen.current && prepared.valid();
    setBusy(true); setStatus(action === "copy" ? "正在复制图片…" : "正在导出 PNG…");
    void (async () => {
      try {
        // Output the decoded preview bitmap without preparing or composing it again.
        const result = await send({ action, ...image, defaultFileName: prepared.fileName });
        if (active()) setStatus(result.canceled ? "已取消保存。" : result.error || (action === "copy"
          ? `已复制图片 · ${state.source}` : `已保存 · ${state.source}：${result.filePath}`));
      } catch (error) {
        if (active()) setStatus(error instanceof Error ? error.message : "输出控件图片失败。");
      } finally {
        if (active()) { pending.current = null; setBusy(false); }
      }
    })();
  }, []);
  return { busy, status, title, preview, run, cancel, outputPreview };
}
