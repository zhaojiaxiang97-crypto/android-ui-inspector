import type { UiNode, UiSnapshot } from "../../../shared/types";
import { nodeDisplayLabel } from "../../../shared/tree-utils";
import { nodeCaptureFacts, type NodeCaptureFacts } from "../../../shared/node-capture-facts";

export type LiveDiagnosisResult = {
  requestId: string; expectedPackage: string; serial: string; startedAt: string; finishedAt: string; snapshot: UiSnapshot;
};
export type DiagnosticImageState = "visible" | "transparent" | "captured" | "style" | "failed" | "ambiguous" | "hidden" | "unavailable" | "unknown";
export const diagnosticImageLabels: Record<DiagnosticImageState, string> = {
  visible: "有可见像素", transparent: "已测全透明", captured: "已取图 · 透明度未知", style: "样式重建",
  failed: "取图失败", ambiguous: "匹配歧义", hidden: "不可见", unavailable: "缺少画面", unknown: "未采集",
};

function imageState(facts: NodeCaptureFacts): DiagnosticImageState {
  if (facts.status === "captured") {
    if (!facts.hasImageData) return "unavailable";
    return facts.empty === true ? "transparent" : facts.empty === false ? "visible" : "captured";
  }
  return facts.status ?? "unknown";
}

export function diagnosticImageState(node: UiNode): DiagnosticImageState {
  return imageState(nodeCaptureFacts(node));
}

export function summarizeLiveDiagnosis(result: LiveDiagnosisResult) {
  const snapshot = result.snapshot;
  const rejection = snapshot.serial !== result.serial ? "设备与本次请求不一致，结果未采用。"
    : snapshot.error ? snapshot.error
    : !snapshot.root ? "没有返回控件树。"
    : snapshot.root.package !== result.expectedPackage ? "App 与本次目标不一致，结果未采用。"
    : snapshot.captureRequestDiagnostics?.totalAttempts !== 1 ? "缺少单次采集记录或实际尝试次数不符，结果未采用。"
    : snapshot.captureMode === "fast" || snapshot.inspectionSource === "uiautomator" || snapshot.inspectionSource === "accessibility-helper"
      ? "语义树不是独立绘制图层，结果未作为图层诊断采用。" : null;
  const counts = Object.fromEntries(Object.keys(diagnosticImageLabels).map(key => [key, 0])) as Record<DiagnosticImageState, number>;
  const rows: Array<{ id: string; name: string; className: string; bounds: string; state: DiagnosticImageState; source: string; reason: string }> = [];
  if (!rejection && snapshot.root) {
    const stack = [snapshot.root];
    while (stack.length) {
      const node = stack.pop()!;
      const facts = nodeCaptureFacts(node);
      const state = imageState(facts);
      counts[state]++;
      rows.push({ id: node.id, name: nodeDisplayLabel(node), className: node.className ?? "未知",
        bounds: node.bounds ? `${node.bounds.left}, ${node.bounds.top} · ${node.bounds.right - node.bounds.left} × ${node.bounds.bottom - node.bounds.top} px` : "未采集",
        state, source: facts.source || facts.captureSource || "来源未标注",
        reason: facts.error || (facts.skipDraw ? "结构容器标记跳过自身绘制；不等于已测透明。"
          : ["unknown", "unavailable", "failed", "ambiguous"].includes(state) ? "没有更具体的取图原因；不能判断为透明。" : "") });
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    }
  }
  const attrs = rejection ? {} : snapshot.root?.attributes ?? {};
  return { rejection, counts, rows,
    processId: attrs["debug-process-id"] || attrs["qml-process-id"] || "未标注",
    component: attrs["debug-component"] || "未标注",
    windowId: attrs["debug-window-name"] || attrs["qml-window-id"] || "未标注",
    source: snapshot.inspectionSource ?? "未标注",
    geometry: snapshot.captureGeometry ? `${snapshot.captureGeometry.screenshotSize.width} × ${snapshot.captureGeometry.screenshotSize.height} px` : "屏幕几何未采集",
  };
}
