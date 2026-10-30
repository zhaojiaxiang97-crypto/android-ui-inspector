import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { DebugMetadataFields } from "../src/components/DebugMetadataFields";
import { indexInspectorProperties } from "../src/features/inspection/inspector-search-index";
import { structuredMetadataFixture, debugTreeDepth } from "../tests/fixtures/structured-values";
import type { DebugField } from "../shared/debug-metadata";

/** Existing tree-ui runner entry, supplied to the integration owner; no device or native API. */
export async function verifyStructuredValues() {
  const host = document.createElement("div"); host.className = "app-shell inspection-active";
  host.style.cssText = "position:fixed;inset:12px auto auto 12px;width:300px;display:block;height:820px";
  document.body.append(host);
  const app = createRoot(host), checks: string[] = [], copied: { label: string; value: string }[] = [];
  const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(`Structured values: ${message}`); };
  const fields = structuredMetadataFixture.groups[0].fields;
  const scope = {}, newScope = {};
  let currentFields = fields, currentScope = scope, query = "", request: { id: string; revision: number } | null = null;
  const render = () => flushSync(() => app.render(<section className="floating-inspector is-docked" style={{ position: "relative", inset: "auto", width: "100%", minWidth: 0, maxWidth: "none", height: 790 }}>
    <div className="inspector-body"><details className="inspector-card inspector-business" open><summary>业务信息</summary><div className="inspector-card-body">
      <details className="inspector-subsection inspector-business-group" open><summary>页面状态</summary>
        <DebugMetadataFields fields={currentFields} groupLabel="页面状态" pathPrefix="state" scope={currentScope} query={query} revealRequest={request}
          onCopyValue={(label, value) => { copied.push({ label, value }); }} />
      </details></div></details></div></section>));
  const detail = (path: string) => [...host.querySelectorAll<HTMLDetailsElement>("details[data-debug-path]")].find(item => item.dataset.debugPath === path)!;
  const summary = (path: string) => detail(path).querySelector<HTMLElement>(":scope > summary")!;
  const click = (element: HTMLElement) => flushSync(() => element.click());
  const filter = (value: string) => { query = value; request = null; render(); };
  const properties = () => indexInspectorProperties(host);
  try {
    render();
    await tick();
    const indexed = properties();
    check(indexed.length === 9, `folded tree has ${indexed.length} properties rather than 9`);
    for (const [label, value] of [["未获取", "null"], ["加载中", "false"], ["重试次数", "0"], ["错误信息", ""]])
      check(indexed.find(item => item.label === label)?.value === value, `${label} lost its exact typed representation`);
    check(!detail("state/detail").open && !detail("state/detail/request").open, "initial tree must be folded");
    const payload = fields[1].type === "tree" ? fields[1].value[0].children[3].value : null;
    check(indexed.find(item => item.label === "内容")?.value === payload, "full Unicode/whitespace value was lost while folded");
    check(indexed.find(item => item.label === "内容")?.terms.some(term => term.includes("state/detail/request/payload")), "real path is absent from search");
    check(!indexed.some(item => [item.value, ...item.terms].join(" ").includes("[object Object]")), "object coercion contaminated search");
    checks.push("folded real rows retain null/false/0/empty/Unicode and exact key paths");

    click(host.querySelector<HTMLButtonElement>('button[aria-label="复制页面状态·业务详情"]')!);
    check(copied.at(-1)?.label === "业务详情" && JSON.stringify(JSON.parse(copied.at(-1)!.value)) === JSON.stringify(fields[1].value), "complete tree copy is not the full original typed data");
    click(host.querySelector<HTMLButtonElement>('button[aria-label="复制页面状态·未获取"]')!);
    check(copied.at(-1)?.value === "null", "nullable scalar copy is not JSON null");
    filter("state/detail/request/payload");
    await tick();
    check(detail("state/detail").open && detail("state/detail/request").open, "path search did not expand ancestors");
    const valueButton = host.querySelector<HTMLButtonElement>('button[aria-label="复制页面状态·业务详情·请求·内容"]')!;
    click(valueButton);
    check(copied.at(-1)?.value === payload, "nested string copy trimmed or truncated the real value");
    filter(""); await tick();
    check(!detail("state/detail").open && !detail("state/detail/request").open, "clearing search did not restore initial folds");
    checks.push("complete tree and nested original values copy without coercion or truncation");

    click(summary("state/detail")); click(summary("state/detail/request"));
    check(detail("state/detail").open && detail("state/detail/request").open, "normal disclosure cannot open");
    filter("缓存加载中"); await tick();
    check(detail("state/detail/cache").open, "label search did not expand the matching branch");
    click(summary("state/detail/cache")); check(!detail("state/detail/cache").open, "temporary search branch cannot be folded");
    const target = properties().find(item => item.label === "缓存加载中")!;
    request = { id: target.id, revision: 1 }; render(); await tick();
    check(detail("state/detail/cache").open, "exact property request did not reopen ancestor folded during search");
    filter(""); await tick();
    check(detail("state/detail").open && detail("state/detail/request").open && !detail("state/detail/cache").open, "search changed the normal user disclosure state");
    checks.push("search and exact result reveal are temporary and restore user disclosure");

    currentScope = newScope; request = null; render(); await tick();
    check(!detail("state/detail").open && !detail("state/detail/request").open, "source replacement reused normal disclosure state");
    filter("内容"); await tick();
    click(summary("state/detail/request"));
    request = { id: "untrusted\" selector", revision: 2 }; render(); await tick();
    check(!detail("state/detail/request").open, "unknown property ID changed a branch");
    filter(""); await tick();
    checks.push("source scope resets disclosure and foreign property IDs cannot reopen rows");

    const deepField: DebugField = { key: "deep", label: "最长业务路径", type: "tree", value: debugTreeDepth(8) };
    currentFields = [...fields, deepField]; currentScope = {}; query = "层级"; render(); await tick();
    for (const width of [300, 248]) {
      host.style.width = `${width}px`; await tick();
      const panel = host.querySelector<HTMLElement>(".floating-inspector")!;
      check(panel.getBoundingClientRect().width <= width + 1, `panel exceeds ${width}px`);
      check(panel.scrollWidth <= panel.clientWidth + 1, `panel overflows at ${width}px`);
      const leaves = [...host.querySelectorAll<HTMLElement>('[data-debug-path="state/deep/level1/level2/level3/level4/level5/level6/level7/level8"]')];
      check(leaves.length > 0 && leaves[0].getBoundingClientRect().width > 35, `depth-8 value unusable at ${width}px`);
      const button = leaves[0].querySelector<HTMLButtonElement>("button")!;
      check(button.getBoundingClientRect().right <= panel.getBoundingClientRect().right + 1, `copy control leaves panel at ${width}px`);
      check([...host.querySelectorAll<HTMLElement>(".inspector-debug-tree-root,.inspector-debug-tree-node,.inspector-debug-tree-leaf")].every(item => item.scrollWidth <= item.clientWidth + 1), `tree content overflows at ${width}px`);
    }
    checks.push("300px and 248px panels keep depth-8 fields and copy controls usable");
    return { checks };
  } finally { flushSync(() => app.unmount()); host.remove(); }
}
