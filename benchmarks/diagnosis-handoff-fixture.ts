import { makeNode } from "./fixtures";
import type { UiSnapshot } from "../shared/types";

export function diagnosisHandoffFixture(screenshotDataUrl: string): UiSnapshot {
  const root = { ...makeNode("0"), text: "本地合成页面", bounds: { left: 0, top: 0, right: 360, bottom: 640, raw: "[0,0][360,640]" },
    attributes: { "debug-process-id": "123", "debug-window-name": "synthetic-window", "debug-component": "com.example.benchmark/.SyntheticActivity" } };
  const title = { ...makeNode("0/0/0", 1), text: "本地设置标题", resourceId: "com.example.benchmark:id/title",
    bounds: { left: 24, top: 72, right: 300, bottom: 124, raw: "[24,72][300,124]" } };
  const group = { ...makeNode("0/0", 4), text: "标题容器", children: [title] };
  const action = { ...makeNode("0/1", 2), text: "本地播放设置", resourceId: "com.example.benchmark:id/playback",
    bounds: { left: 24, top: 140, right: 336, bottom: 196, raw: "[24,140][336,196]" } };
  root.children = [group, action];
  return { serial: "synthetic-device", root, nodeCount: 4, xmlSize: 0, rawXml: null, screenshotDataUrl,
    error: null, warning: "本地合成数据，不是手机页面", inspectionSource: "debug-view",
    captureRequestDiagnostics: { totalAttempts: 1, totalDurationMs: 1, droppedAttempts: 0, attempts: [] } };
}
