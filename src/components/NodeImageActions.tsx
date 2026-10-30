import { useLayoutEffect, useRef, useState } from "react";
import type { QmlGroupImage, UiNode } from "../../shared/types";
import { nodeImageExportPlan, type NodeImageScope } from "../../shared/node-image-export";
import { nodeShortClass } from "../../shared/tree-utils";
import { prepareNodeImageExport } from "../features/layers/prepareNodeImageExport";

export function NodeImageActions({ root, node, groupImage = null, sessionKey }: {
  root: UiNode; node: UiNode; groupImage?: QmlGroupImage | null; sessionKey?: string | number;
}) {
  const [scope, setScope] = useState<NodeImageScope>("own");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const branchImage = scope === "branch" ? groupImage : null;
  useLayoutEffect(() => {
    pending.current?.abort(); pending.current = null; setBusy(false); setStatus(null);
    return () => { pending.current?.abort(); pending.current = null; };
  }, [root, node, branchImage, sessionKey, scope]);
  const plan = nodeImageExportPlan(node, scope, groupImage);
  const supported = Boolean(window.electronApi?.outputNodeImage);
  async function output(action: "save" | "copy") {
    const send = window.electronApi?.outputNodeImage;
    if (!send || pending.current || plan.kind === "unavailable") return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setStatus(action === "save" ? "正在准备 PNG…" : "正在准备复制…");
    try {
      const image = await prepareNodeImageExport(node, plan, controller.signal);
      if (controller.signal.aborted) return;
      const name = `${plan.fileTag}-${nodeShortClass(node)}-${node.id}`.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 140);
      const result = await send({ action, ...image, defaultFileName: `${name}.png` });
      if (pending.current !== controller) return;
      setStatus(result.canceled ? null : result.error || (action === "copy" ? `已复制图片 · ${plan.label}` : `已保存 · ${plan.label}：${result.filePath}`));
    } catch (error) {
      if (pending.current === controller && !controller.signal.aborted) setStatus(error instanceof Error ? error.message : "输出控件图片失败。");
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false); }
    }
  }
  return <section className="node-image-output" aria-label="控件图片输出">
    <label>图片范围<select aria-label="控件图片范围" value={scope} onChange={event => setScope(event.target.value as NodeImageScope)}>
      <option value="own">自身图</option><option value="branch">此分支（含子层）</option>
    </select></label>
    <strong className="node-image-output-source" data-image-source={plan.kind}>{plan.label}</strong>
    <p className="inspector-image-note">{plan.detail}</p>
    <div className="node-image-output-buttons">
      <button type="button" disabled={busy || !supported || plan.kind === "unavailable"} onClick={() => void output("save")}>导出 PNG</button>
      <button type="button" disabled={busy || !supported || plan.kind === "unavailable"} onClick={() => void output("copy")}>复制图片</button>
    </div>
    {!supported && <p className="inspector-image-note">当前版本尚不支持控件图片输出。</p>}
    {status && <p className="inspector-image-note node-image-output-status" role="status">{status}</p>}
  </section>;
}
