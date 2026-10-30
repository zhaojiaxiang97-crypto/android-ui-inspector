import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { UiNode, UiSnapshot } from "../shared/types";
import { parseLayoutRules, type LayoutRules } from "../shared/layout-relations";
import { LayoutRuleProperties } from "../src/components/LayoutRuleProperties";
import { indexInspectorProperties } from "../src/features/inspection/inspector-search-index";
import { searchInspectorProperties } from "../shared/inspector-search";
import { useInspectionWorkspace } from "../src/features/inspection/useInspectionWorkspace";
import { makeNode } from "./fixtures";

export async function verifyLayoutRelations() {
  const previousApi = window.electronApi;
  const host = document.createElement("div");
  host.className = "app-shell inspection-active";
  host.style.cssText = "position:relative;width:1000px;height:650px;";
  document.body.append(host);
  const renderer = createRoot(host), checks: string[] = [];
  const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const act = (action: () => void) => flushSync(action);
  const assert = (value: unknown, message: string) => { if (!value) throw new Error(`Layout relations: ${message}`); };
  const root = makeNode("root-opaque"), parent = makeNode("parent-opaque"), source = makeNode("source-opaque"), first = makeNode("first-opaque"), second = makeNode("second-opaque");
  parent.className = "androidx.constraintlayout.widget.ConstraintLayout"; parent.text = "真实父容器";
  source.resourceId = "com.example.app:id/source"; source.text = "源控件";
  first.resourceId = "com.example.app:id/title"; first.text = "标题目标";
  second.resourceId = "com.example.app:id/body"; second.text = "内容目标";
  root.children = [parent]; parent.children = [source, first, second];
  const rules: LayoutRules = { type: "ConstraintLayout", rules: [["leftToLeft", first.resourceId!], ["topToBottom", second.resourceId!],
    ["rightToRight", "parent"], ["horizontalBias", "0.5"], ["circleRadius", "0"], ["unknownRule", false]] };
  source.attributes = { "sdk-layout-rules": JSON.stringify({ type: rules.type, rules: Object.fromEntries(rules.rules) }) };
  const original = JSON.stringify(root);
  const navigations: { node: UiNode; root: UiNode }[] = [], copies: { label: string; value: string }[] = [];
  const onNavigate = (node: UiNode, sourceRoot: UiNode) => { navigations.push({ node, root: sourceRoot }); return true; };
  const copy = (label: string, value: string) => { copies.push({ label, value }); };
  const render = (inputRoot = root, node = source, value = rules, disabled = false, width = 300) => act(() => renderer.render(
    <aside className="floating-inspector" style={{ width }}><div className="inspector-body">
      <details className="inspector-card inspector-layout" open><summary>布局</summary><div className="inspector-card-body">
        <dl className="inspector-property-list"><LayoutRuleProperties root={inputRoot} node={node} rules={value}
          onNavigateNode={onNavigate} navigationDisabled={disabled} onCopyValue={copy} /></dl>
      </div></details>
    </div></aside>));
  const row = (name: string) => host.querySelector<HTMLElement>(`[data-layout-rule="${name}"]`)!;
  const target = (name: string) => row(name)?.querySelector<HTMLButtonElement>(".inspector-layout-target");
  const click = (control: HTMLElement | null | undefined) => { assert(control, "missing control"); act(() => control!.click()); };
  let workspace!: ReturnType<typeof useInspectionWorkspace>, forceDisabled = false;
  const reads: string[] = [];
  window.electronApi = { ...previousApi,
    onInspectionProgress: () => () => {}, onInspectionPreview: () => () => {},
    cancelInspection: async () => {},
    inspectDevice: async () => { reads.push("capture"); throw new Error("Unexpected layout navigation capture"); },
    refreshViewNode: async () => { reads.push("refresh"); throw new Error("Unexpected layout navigation refresh"); },
    captureGroup: async () => { reads.push("group"); throw new Error("Unexpected layout navigation group"); },
    readViewStyle: async () => { reads.push("style"); throw new Error("Unexpected layout navigation style"); },
  };
  function Harness() {
    workspace = useInspectionWorkspace();
    const currentRoot = workspace.snapshot?.root, current = workspace.selectedNode;
    const currentRules = parseLayoutRules(current?.attributes?.["sdk-layout-rules"]);
    if (!currentRoot || !current || !currentRules) return null;
    return <dl className="inspector-property-list"><LayoutRuleProperties root={currentRoot} node={current} rules={currentRules}
      onNavigateNode={workspace.navigateToNode} navigationDisabled={forceDisabled || workspace.inspectionLoading || Boolean(workspace.viewRefreshingNodeId)} /></dl>;
  }
  const snapshot: UiSnapshot = { serial: "layout-relation-fixture", root, nodeCount: 5, xmlSize: 0, rawXml: null,
    screenshotDataUrl: null, warning: null, error: null, captureMode: "deep", inspectionSource: "debug-hybrid" };
  try {
    render(); await tick();
    assert(host.querySelectorAll(".inspector-layout-target").length === 3, "scalar or boolean values became target links");
    assert(row("leftToLeft").dataset.inspectorValue === first.resourceId && row("leftToLeft").dataset.inspectorTerms?.includes("leftToLeft"), "original search metadata lost");
    click(target("leftToLeft")); click(target("topToBottom")); click(target("rightToRight"));
    assert(navigations[0]?.node === first && navigations[1]?.node === second && navigations[2]?.node === parent
      && navigations.every(item => item.root === root), "distinct links did not pass the actual target/root");
    target("leftToLeft")!.focus();
    assert(document.activeElement === target("leftToLeft") && target("leftToLeft")!.getAttribute("aria-label")?.includes("标题目标"), "target lacks keyboard focus or accessible purpose");
    click(row("leftToLeft").querySelector('[aria-label="复制左边 → 目标左边原值"]'));
    click(row("unknownRule").querySelector(".inspector-field-copy"));
    assert(copies[0]?.value === first.resourceId && copies[1]?.value === "false", "copy changed the complete ID or boolean");
    const properties = indexInspectorProperties(host);
    assert(searchInspectorProperties(properties, first.resourceId!).results.some(item => item.value === first.resourceId), "complete target ID cannot be searched");
    assert(searchInspectorProperties(properties, "leftToLeft").results.length === 1, "rule name cannot be searched");
    assert(searchInspectorProperties(properties, first.text!).results.some(item => item.value === first.resourceId), "displayed target name cannot be searched");
    checks.push("distinct target/parent native buttons, keyboard focus, full raw copy and actual inspector search index");

    first.text = `${"长目标名称".repeat(80)}tail`; first.resourceId = `com.example.app:id/${"long_target_".repeat(25)}`;
    const longRules: LayoutRules = { ...rules, rules: [["leftToLeft", first.resourceId]] };
    for (const width of [300, 248]) {
      render(root, source, longRules, false, width); await tick();
      const panel = host.querySelector<HTMLElement>(".floating-inspector")!, control = target("leftToLeft")!;
      assert(Math.abs(panel.getBoundingClientRect().width - width) <= 1, `actual width differs from ${width}px`);
      assert(panel.scrollWidth <= panel.clientWidth + 1 && row("leftToLeft").scrollWidth <= row("leftToLeft").clientWidth + 1,
        `long layout target overflows at ${width}px`);
      assert(control.title.includes(first.text) && row("leftToLeft").dataset.inspectorValue === first.resourceId, "long value was shortened in source/title");
      assert(control.getBoundingClientRect().height >= 24, "target click area is too small");
    }
    checks.push("300/248px rendered panels keep long names and IDs within the panel, full title/value and a 24px target");
    first.text = "标题目标"; first.resourceId = "com.example.app:id/title";

    const ambiguousRoot = structuredClone(root), ambiguousParent = ambiguousRoot.children[0], ambiguousSource = ambiguousParent.children[0];
    const duplicate = makeNode("duplicate"); duplicate.resourceId = first.resourceId; ambiguousParent.children.push(duplicate);
    const unresolvedRules: LayoutRules = { ...rules, rules: [["leftToLeft", first.resourceId], ["topToTop", "com.example.app:id/missing"], ["bottomToBottom", "id/0x99"]] };
    render(ambiguousRoot, ambiguousSource, unresolvedRules); await tick();
    assert(!host.querySelector(".inspector-layout-target"), "ambiguous or absent targets became links");
    assert(row("leftToLeft").textContent?.includes("同级资源 ID 重复") && row("topToTop").textContent?.includes("当前同级未找到")
      && row("bottomToBottom").textContent?.includes("资源 ID 不完整"), "unresolved reason missing");
    assert(row("leftToLeft").textContent?.includes(first.resourceId!), "unresolved complete ID hidden");
    render(root, { ...source }, rules);
    assert(!host.querySelector(".inspector-layout-target") && row("leftToLeft").textContent?.includes("控件不在当前树中"), "foreign source became navigable");
    render(source, source, rules);
    assert(!host.querySelector(".inspector-layout-target") && row("leftToLeft").textContent?.includes("当前树缺少父容器"), "partial root created a guessed parent");
    checks.push("duplicate, absent, incomplete, foreign and partial-tree references retain raw values and clear non-link reasons");

    render(root, source, rules, true);
    const beforeDisabled = navigations.length;
    assert([...host.querySelectorAll<HTMLButtonElement>(".inspector-layout-target")].every(control => control.disabled), "navigation guard did not disable links");
    click(target("leftToLeft"));
    assert(navigations.length === beforeDisabled, "disabled link navigated");
    checks.push("navigation-disabled controls stay inert while raw-value copying remains available");

    act(() => renderer.render(<Harness />)); await tick();
    act(() => workspace.showSnapshot(snapshot, source.id));
    act(() => { workspace.setTreeQuery("unrelated-filter"); workspace.setInteractiveOnly(true); workspace.setIdentifiedOnly(true); });
    const revealBefore = workspace.treeRevealRequest;
    click(target("leftToLeft"));
    assert(workspace.selectedNode === first && workspace.treeRevealRequest > revealBefore && !workspace.treeQuery
      && !workspace.interactiveOnly && !workspace.identifiedOnly, "workspace did not select/reveal and clear filters");
    act(() => workspace.handleLayerAction("hide", first));
    act(() => workspace.setSelectedNode(source)); click(target("leftToLeft"));
    assert(workspace.selectedNode === first && workspace.hiddenNodeIds.has(first.id), "locating a hidden target changed layer visibility");
    act(() => workspace.setSelectedNode(source)); click(target("topToBottom"));
    assert(workspace.selectedNode === second, "the second target navigated to the first target");
    act(() => workspace.handleLayerAction("focus-branch", parent));
    act(() => workspace.setSelectedNode(source)); click(target("leftToLeft"));
    assert(workspace.layerFocus?.node === parent && workspace.selectedNode === first, "in-branch target unnecessarily exited focus");
    act(() => workspace.handleLayerAction("focus", source));
    click(target("topToBottom"));
    assert(!workspace.layerFocus && workspace.selectedNode === second, "out-of-focus target did not leave single-layer focus");
    act(() => workspace.setSelectedNode(source)); click(target("rightToRight"));
    assert(workspace.selectedNode === parent, "parent link did not select the real container");
    checks.push("existing workspace navigation selects distinct targets/parent, reveals, clears filters, keeps hidden layers and preserves/exits focus as applicable");

    act(() => workspace.setSelectedNode(source));
    const oldNavigate = workspace.navigateToNode;
    const replacement = structuredClone(snapshot);
    act(() => workspace.showSnapshot(replacement, source.id));
    assert(!oldNavigate(first, root) && !workspace.navigateToNode(first, root), "old root callback escaped session isolation");
    const replacementFirst = replacement.root!.children[0].children[1];
    click(target("leftToLeft"));
    assert(workspace.selectedNode === replacementFirst && workspace.selectedNode !== first, "same-ID replacement navigated to a stale object");
    act(() => workspace.setSelectedNode(replacement.root!.children[0].children[0]));
    forceDisabled = true; act(() => renderer.render(<Harness />));
    click(target("topToBottom"));
    assert(workspace.selectedNode?.id === source.id, "busy override navigated");
    assert(!reads.length && JSON.stringify(root) === original, "layout navigation changed source data or requested device data");
    checks.push("old snapshot/epoch callbacks reject, same IDs use replacement objects, busy guard blocks and no capture/group/style/refresh reads");
    return { checks };
  } finally {
    act(() => renderer.unmount()); host.remove(); window.electronApi = previousApi;
  }
}
