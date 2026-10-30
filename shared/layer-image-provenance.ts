export type GroupRequestState = "pending" | "unavailable";

// "composite" is a rendering role, not evidence of where the pixels came from.
export function layerImageProvenance(options: {
  collapsed: boolean; hasGroup: boolean; hiddenDescendants: boolean;
  canRequestGroup: boolean; requestState?: GroupRequestState; ownSource?: string;
}) {
  if (!options.collapsed) return { source: options.ownSource ?? "unknown", groupState: "not-applicable" };
  if (options.hasGroup && !options.hiddenDescendants) return { source: "live-group", groupState: "ready" };
  return { source: "local-composite", groupState: options.hiddenDescendants ? "hidden-descendants"
    : !options.canRequestGroup ? "not-live" : options.requestState ?? "not-requested" };
}

// Source labels are not a strict pixel-verification result.
export function layerImagePresentation(provenance: { source: string; groupState: string }) {
  if (provenance.source === "none") return { label: "仅边框", detail: "当前图层没有可展示画面，不代表透明。" };
  if (provenance.source === "live-group") return { label: "原生整组图", detail: "实时读取，不保证与原快照同帧；来源不代表逐像素校验通过。" };
  if (provenance.source === "local-composite") {
    const reason = provenance.groupState === "pending" ? "正在读取原生整组图，暂用本地重建。"
      : provenance.groupState === "unavailable" ? "原生整组图未取得，原因未返回。"
      : provenance.groupState === "hidden-descendants" ? "已排除隐藏子图层，不使用包含它们的原生整组图。"
      : provenance.groupState === "not-live" ? "当前无法请求原生整组图。"
      : "尚未取得原生整组图。";
    return { label: "本地重建图", detail: `${reason}由已采集图层合成，不保证与原生整组图逐像素一致。` };
  }
  return { label: "独立画面", detail: "图层独立画面；来源不代表逐像素校验通过。" };
}
