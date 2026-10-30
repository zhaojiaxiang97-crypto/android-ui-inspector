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
};

export function useNodeImageActionController({ root, node, sessionKey }: {
  root: UiNode | null; node?: UiNode | null; sessionKey?: string | number;
}): NodeImageActionController {
  const [busy, setBusy] = useState(false), [status, setStatus] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null), [preview, setPreview] = useState<NodeImagePreviewState | null>(null);
  const pending = useRef<AbortController | null>(null), previewOpen = useRef(false);
  const lastKey = useRef<string | number | undefined>(undefined);
  const treeIndex = useMemo(() => root ? indexTree(root) : null, [root]);
  const current = useRef({ root, node, sessionKey, treeIndex });
  current.current = { root, node, sessionKey, treeIndex };
  const cancel = useCallback(() => {
    pending.current?.abort(); pending.current = null; previewOpen.current = false;
    setBusy(false); setStatus(null); setTitle(null); setPreview(null);
  }, []);
  useLayoutEffect(() => {
    cancel(); lastKey.current = undefined;
    return () => { pending.current?.abort(); pending.current = null; previewOpen.current = false; };
  }, [root, node, sessionKey, cancel]);
  const run = useCallback((request: NodeImageActionRequest) => {
    const owner = current.current;
    if (!owner.root || request.root !== owner.root || request.sessionKey !== owner.sessionKey
      || (owner.node && request.node !== owner.node)
      || owner.treeIndex?.get(request.node.id)?.node !== request.node
      || (request.key !== undefined && request.key === lastKey.current)) return;
    if (pending.current || previewOpen.current) return;
    const plan = nodeImageExportPlan(request.node, request.scope, request.groupImage ?? null);
    if (plan.kind === "unavailable") return;
    const send = window.electronApi?.outputNodeImage;
    if (request.action !== "preview" && !send) return;
    lastKey.current = request.key;
    const controller = new AbortController(); pending.current = controller;
    const active = () => pending.current === controller && !controller.signal.aborted
      && current.current.root === owner.root && current.current.node === owner.node && current.current.sessionKey === owner.sessionKey;
    const name = `${nodeDisplayLabel(request.node)} · ${nodeShortClass(request.node)}`;
    setBusy(true); setTitle(name);
    if (request.action === "preview") {
      previewOpen.current = true; setStatus(null);
      const description: NodeImagePreviewState = { title: name, source: plan.label, detail: plan.detail, sourceKind: plan.kind, image: null, error: null };
      setPreview(description);
      void (async () => {
        try {
          const image = await prepareNodeImagePreview(request.node, plan, controller.signal);
          if (active()) setPreview({ ...description, image });
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
          const fileName = `${plan.fileTag}-${nodeShortClass(request.node)}-${request.node.id}`.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 140);
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
  return { busy, status, title, preview, run, cancel };
}
