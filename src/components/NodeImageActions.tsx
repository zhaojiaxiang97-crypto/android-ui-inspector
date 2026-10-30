import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { QmlGroupImage, UiNode } from "../../shared/types";
import { nodeImageExportPlan, type NodeImageScope } from "../../shared/node-image-export";
import { useNodeImageActionController, type NodeImageActionController } from "../features/layers/useNodeImageActionController";
import { NodeImagePreview } from "./NodeImagePreview";

type NodeImageActionsProps = {
  root: UiNode; node: UiNode; groupImage?: QmlGroupImage | null; sessionKey?: string | number;
  controller?: NodeImageActionController;
};

export function NodeImageActions(props: NodeImageActionsProps) {
  return props.controller ? <NodeImageActionControls {...props} controller={props.controller} /> : <LocalNodeImageActions {...props} />;
}
function LocalNodeImageActions(props: NodeImageActionsProps) {
  const controller = useNodeImageActionController({ ...props, groupImage: props.groupImage ?? null });
  return <NodeImageActionControls {...props} controller={controller} local />;
}
function NodeImageActionControls({ root, node, groupImage = null, sessionKey, controller, local = false }: NodeImageActionsProps & {
  controller: NodeImageActionController; local?: boolean;
}) {
  const [scope, setScope] = useState<NodeImageScope>("own");
  useLayoutEffect(() => { if (local) controller.cancel(); }, [scope, local, controller.cancel]);
  const plan = nodeImageExportPlan(node, scope, groupImage);
  const supported = Boolean(window.electronApi?.outputNodeImage), busy = controller.busy;
  const preview = controller.preview;
  const run = (action: "save" | "copy" | "preview") => controller.run({ root, node, groupImage, sessionKey, scope, action });
  return <section className="node-image-output" aria-label="控件图片输出">
    <label>图片范围<select aria-label="控件图片范围" value={scope} onChange={event => { controller.cancel(); setScope(event.target.value as NodeImageScope); }}>
      <option value="own">自身图</option><option value="branch">此分支（含子层）</option>
    </select></label>
    <strong className="node-image-output-source" data-image-source={plan.kind}>{plan.label}</strong>
    <p className="inspector-image-note">{plan.detail}</p>
    <div className="node-image-output-buttons">
      <button type="button" className="node-image-save" disabled={busy || !supported || plan.kind === "unavailable"} onClick={() => run("save")}>导出 PNG</button>
      <button type="button" className="node-image-copy" disabled={busy || !supported || plan.kind === "unavailable"} onClick={() => run("copy")}>复制图片</button>
      <button type="button" className="node-image-preview-open" disabled={(busy && !controller.preview) || plan.kind === "unavailable"} onClick={() => run("preview")}>预览图片</button>
      {controller.busy && !controller.preview && <button type="button" className="node-image-cancel" onClick={controller.cancel}>取消准备</button>}
    </div>
    {!supported && <p className="inspector-image-note">当前环境不支持保存或复制。</p>}
    {local && controller.status && !preview && <p className="inspector-image-note node-image-output-status" role="status">{controller.status}</p>}
    {local && preview && <NodeImagePreview state={preview} onClose={controller.cancel}
      output={{ busy, status: controller.status, supported, run: action => controller.outputPreview(preview, action) }} />}
  </section>;
}

export function NodeImageActionOverlay({ controller }: { controller: NodeImageActionController }) {
  const preview = controller.preview;
  return createPortal(<>
    {controller.status && !controller.preview && <aside className="node-image-action-feedback" aria-label="控件图片结果">
      <strong title={controller.title ?? undefined}>{controller.title}</strong>
      <p className="node-image-output-status" role="status">{controller.status}</p>
      <button type="button" onClick={controller.cancel}>{controller.busy ? "取消准备" : "关闭结果"}</button>
    </aside>}
    {preview && <NodeImagePreview state={preview} onClose={controller.cancel}
      output={{ busy: controller.busy, status: controller.status, supported: Boolean(window.electronApi?.outputNodeImage), run: action => controller.outputPreview(preview, action) }} />}
  </>, document.body);
}
