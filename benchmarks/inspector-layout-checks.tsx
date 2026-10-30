import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { WORKSPACE_LAYOUT_STORAGE_KEY, type WorkspaceLayout } from "../shared/workspace-layout";
import { makeNode } from "./fixtures";
import { NodePropertiesPanel } from "../src/components/NodePropertiesPanel";
import { TreePaneResizer } from "../src/components/TreePaneResizer";
import { useWorkspaceLayout } from "../src/features/inspection/useWorkspaceLayout";

export async function verifyInspectorLayout() {
  const previous = localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY), originalSet = Storage.prototype.setItem;
  localStorage.removeItem(WORKSPACE_LAYOUT_STORAGE_KEY);
  const host = document.createElement("div"); document.body.append(host);
  let mounted = createRoot(host), state!: ReturnType<typeof useWorkspaceLayout>, resize!: (width: number) => void;
  const node = { ...makeNode("layout-root"), text: "布局记忆样例" };
  function Harness() {
    const layout = useWorkspaceLayout(); state = layout;
    const [width, setWidth] = useState(1000), [toolbar, setToolbar] = useState<HTMLDivElement | null>(null); resize = setWidth;
    return <div className="app-shell inspection-active" style={{ width, maxWidth: "100vw", height: 650, position: "fixed", left: 0, top: 0, zIndex: 200 }}>
      <header className="inspection-header"><div className="scene-toolbar-host workbench-scene-tools" ref={setToolbar} /></header>
      <div className="inspector-grid is-resizable" style={{ height: 550 }}>
        <div className="tree-pane" /><TreePaneResizer width={layout.workspaceLayout.treeWidth}
          onWidthChange={treeWidth => layout.saveWorkspaceLayout({ ...layout.workspaceLayout, treeWidth })} />
        <div className="preview-pane" style={{ position: "relative", height: 550 }}>
          <NodePropertiesPanel root={node} node={node} docked toolbarHost={toolbar} imageSessionKey={1} screenshotSize={null}
            inspectorLayout={layout.workspaceLayout.inspector}
            onInspectorLayoutChange={inspector => layout.saveWorkspaceLayout({ ...layout.workspaceLayout, inspector })}
            onCopy={() => {}} copyStatus={null} children={null} />
        </div>
      </div>
    </div>;
  }
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
  const check = (value: unknown, message: string) => { if (!value) throw new Error(`Inspector layout: ${message}`); };
  const get = (selector: string) => { const element = host.querySelector<HTMLElement>(selector); check(element, `missing ${selector}`); return element!; };
  const click = async (selector: string) => { flushSync(() => get(selector).click()); await settle(); };
  const key = async (selector: string, name: string) => { flushSync(() => get(selector).dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }))); await settle(); };
  const stored = () => JSON.parse(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)!) as WorkspaceLayout;
  try {
    flushSync(() => mounted.render(<Harness />)); await settle();
    await key(".tree-pane-resizer", "ArrowLeft"); check(stored().treeWidth === 296, "tree width was not persisted");
    await click(".inspector-detach"); check(stored().inspector.floating && !get(".floating-inspector").classList.contains("is-docked"), "floating mode was not persisted");
    await key(".inspector-drag-handle", "ArrowLeft");
    await key(".inspector-resize-handle", "ArrowUp");
    const preferred = stored().inspector.rect!;
    check(preferred.width === get(".floating-inspector").offsetWidth && preferred.height === get(".floating-inspector").offsetHeight, "keyboard resize did not save real dimensions");
    flushSync(() => resize(650)); await settle();
    const panel = get(".floating-inspector"), workspace = panel.parentElement!;
    check(panel.offsetLeft >= 0 && panel.offsetLeft + panel.offsetWidth <= workspace.clientWidth + 1
      && panel.offsetTop + panel.offsetHeight <= workspace.clientHeight + 1, "small workspace lost the floating panel");
    check(JSON.stringify(stored().inspector.rect) === JSON.stringify(preferred), "viewport clamping overwrote preferred geometry");
    flushSync(() => resize(1000)); await settle();
    check(panel.offsetWidth === preferred.width && panel.offsetHeight === preferred.height, "larger workspace did not restore preferred size");
    await click(".inspector-collapse"); await key(".inspector-drag-handle", "ArrowLeft");
    check(stored().inspector.rect!.height === preferred.height && panel.offsetHeight < 100, "collapsed movement replaced the expanded size");
    await click(".inspector-collapse");
    const beforeReopen = stored(); flushSync(() => mounted.unmount()); mounted = createRoot(host);
    flushSync(() => mounted.render(<Harness />)); await settle();
    check(state.workspaceLayout.inspector.floating && get(".floating-inspector").offsetWidth === beforeReopen.inspector.rect!.width,
      "reopening lost the saved floating layout");
    Storage.prototype.setItem = function (name, value) { if (name === WORKSPACE_LAYOUT_STORAGE_KEY) throw new Error("fixture storage denied"); return originalSet.call(this, name, value); };
    await key(".inspector-resize-handle", "ArrowUp");
    check(Boolean(state.workspaceLayoutError) && get(".inspector-layout-error").textContent?.includes("保存失败"), "layout save failure was hidden");
    Storage.prototype.setItem = originalSet;
    flushSync(() => state.resetWorkspaceLayout()); await settle();
    check(get(".floating-inspector").classList.contains("is-docked") && stored().treeWidth === 306 && stored().inspector.rect === null, "reset left persisted geometry behind");
    return { passed: true, checks: ["tree width", "floating and keyboard size", "viewport clamping preserves preferences", "collapsed size", "remount", "save failure", "reset"] };
  } finally {
    Storage.prototype.setItem = originalSet; flushSync(() => mounted.unmount()); host.remove();
    if (previous === null) localStorage.removeItem(WORKSPACE_LAYOUT_STORAGE_KEY); else localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, previous);
  }
}
