import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { NodePropertiesPanel } from "../src/components/NodePropertiesPanel";
import type { UiNode } from "../shared/types";
import type { ViewFontResult } from "../shared/view-font";
import { makeNode } from "./fixtures";
import "../src/styles/tokens.css";
import "../src/App.css";
import "../src/styles/workbench.css";
import "../src/styles/appearance.css";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function verifyFontProperties() {
  const host = document.createElement("div"); document.body.append(host);
  const renderer = createRoot(host), copies: { label: string; value: string }[] = [], canceled: string[] = [];
  const reads: ReturnType<typeof deferred<ViewFontResult>>[] = [];
  let cancelGate: ReturnType<typeof deferred<void>> | null = null;
  const cancel = (session: string) => { canceled.push(session); return cancelGate?.promise ?? Promise.resolve(); };
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(`Font properties: ${message}`); };
  const settle = async () => { for (let i = 0; i < 3; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
  const get = <T extends HTMLElement = HTMLElement>(selector: string) => {
    const result = host.querySelector<T>(selector); check(result, `missing ${selector}`); return result!;
  };
  const click = async (selector: string) => { flushSync(() => get(selector).click()); await settle(); };
  const node: UiNode = { ...makeNode("0/0", 1), attributes: { "view-ref": "TextView@a", "text-style-source": "view-debug", "text-size-px": "22.5" } };
  const root: UiNode = { ...makeNode("0"), children: [node] }, original = JSON.stringify(root);
  const healthy: ViewFontResult = { ref: "TextView@a", capturedAtMillis: 1_792_000_000_000, source: "jdwp", basis: "text-paint",
    familyName: "sans-serif", familyNameStatus: "system-family", weight: 500, style: 2, usesDefaultTypeface: false };
  let selected = node, source = root, session: string | null = "live-a", capable = true;
  const render = async () => {
    flushSync(() => renderer.render(<div className="app-shell inspection-active" style={{ height: 850 }}>
      <div className="preview-pane" style={{ height: 830, width: 248, position: "relative" }}>
        <NodePropertiesPanel root={source} node={selected} imageSessionKey="tree-a" fontSessionKey={session} screenshotSize={null} toolbarHost={null} docked
          onCopy={() => {}} copyStatus={null} onCopyValue={(label, value) => copies.push({ label, value })} onCancelFont={cancel}
          onReadFont={capable ? () => { const read = deferred<ViewFontResult>(); reads.push(read); return read.promise; } : undefined}>
          {null}
        </NodePropertiesPanel>
      </div>
    </div>)); await settle();
  };
  const search = async (query: string) => {
    flushSync(() => {
      const input = get<HTMLInputElement>('[aria-label="搜索属性"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }); await settle();
  };
  const result = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(".inspector-search-result")]
    .find(button => button.querySelector("strong")?.textContent === label);
  const row = (key: string) => get(`[data-font-property="${key}"]`);
  const resolveLatest = async (value: ViewFontResult = healthy) => { reads.at(-1)!.resolve(value); await settle(); };
  try {
    await render(); await search("font"); await search("");
    check(reads.length === 0, "mount or search read a font automatically");
    flushSync(() => { get(".inspector-font-read").click(); get(".inspector-font-read").click(); }); await settle();
    check(reads.length === 1, "rapid clicks did not share the pending read");
    await render(); check(reads.length === 1 && canceled.length === 0, "callback rerender canceled or repeated the read");
    await resolveLatest();
    check(row("font-family").textContent?.includes("sans-serif") && row("font-weight").textContent?.includes("500"), "font facts missing");
    check(row("font-italic").textContent?.includes("是") && row("font-default").textContent?.includes("否"), "italic/default facts changed");
    check(get(".inspector-font-result").textContent?.includes("当前绘制基础字体 · 实时读取") && get(".inspector-font-result").textContent?.includes("不修改快照"), "basis, time or snapshot boundary missing");
    for (const [query, label] of [["字体家族", "字体家族"], ["familyName", "字体家族"], ["fontWeight", "字重"], ["italic", "斜体"], ["usesDefaultTypeface", "默认字体回退"]]) {
      await search(query); check(result(label), `missing concrete search result ${query}`);
    }
    await search("familyName");
    flushSync(() => result("字体家族")!.parentElement!.querySelector<HTMLButtonElement>(".inspector-search-result-copy")!.click());
    check(copies.at(-1)?.value === "sans-serif", "search copy changed family name");
    await search(""); await click('[data-font-property="font-weight"] button'); check(copies.at(-1)?.value === "500", "weight copy changed value");
    await click('[data-font-property="font-italic"] button'); check(copies.at(-1)?.value === "true", "italic copy changed boolean");
    check(reads.length === 1, "search or copy requested another font");
    for (const [status, expected] of [["not-exposed", "未提供名称"], ["unsupported", "当前系统不支持读取名称"]] as const) {
      await click(".inspector-font-read"); await resolveLatest({ ...healthy, familyName: null, familyNameStatus: status, weight: null, style: null, usesDefaultTypeface: true });
      check(row("font-family").textContent?.includes(expected) && !row("font-family").textContent?.includes("自定义"), "unknown name was guessed");
      check(row("font-default").textContent?.includes("是"), "default Typeface fact missing");
    }
    await click(".inspector-font-read"); reads.at(-1)!.reject(new Error("读取超时")); await settle();
    check(get(".inspector-font-error").textContent === "读取超时" && get(".inspector-font-read").textContent === "重试读取字体", "failure cannot retry");
    await click(".inspector-font-read"); await resolveLatest(); check(!host.querySelector(".inspector-font-error"), "retry retained stale error");
    await click(".inspector-font-read"); await resolveLatest({ ...healthy, ref: "TextView@wrong" });
    check(!host.querySelector(".inspector-font-result") && host.querySelector(".inspector-font-error"), "wrong identity was displayed");
    await click(".inspector-font-read"); const oldNodeRead = reads.at(-1)!;
    cancelGate = deferred<void>(); selected = { ...node, attributes: { ...node.attributes, "view-ref": "TextView@b" } }; await render();
    check(canceled.at(-1) === "live-a" && !host.querySelector(".inspector-font-error"), "node replacement did not cancel old read or clear error");
    const beforeNew = reads.length; await click(".inspector-font-read"); check(reads.length === beforeNew, "new font read raced old cancellation");
    cancelGate.resolve(); cancelGate = null; await settle(); check(reads.length === beforeNew + 1, "new read did not resume after cancellation");
    oldNodeRead.resolve(healthy); await settle(); check(!host.querySelector(".inspector-font-result"), "late old-node result became visible");
    await resolveLatest({ ...healthy, ref: "TextView@b" }); check(row("font-family").textContent?.includes("sans-serif"), "new-node read failed");
    await click(".inspector-font-read"); const oldRootRead = reads.at(-1)!; source = { ...root }; await render();
    oldRootRead.resolve({ ...healthy, ref: "TextView@b" }); await settle(); check(!host.querySelector(".inspector-font-result"), "late old-snapshot result became visible");
    await click(".inspector-font-read"); const oldSessionRead = reads.at(-1)!; session = "live-b"; await render();
    check(canceled.at(-1) === "live-a", "session transition canceled the new session instead of old");
    oldSessionRead.resolve({ ...healthy, ref: "TextView@b" }); await settle(); check(!host.querySelector(".inspector-font-result"), "late old-session result became visible");
    await click(".inspector-font-read"); const offlineRead = reads.at(-1)!; capable = false; session = null; await render();
    offlineRead.resolve({ ...healthy, ref: "TextView@b" }); await settle();
    check(!host.querySelector(".inspector-font-read") && !host.querySelector(".inspector-font-result") && host.querySelector(".inspector-text-style"), "offline retained live access/result or removed saved style");
    capable = true; session = "live-c"; await render(); await click(".inspector-font-read");
    const capabilityRead = reads.at(-1)!; capable = false; await render(); capabilityRead.reject(new Error("stale capability error")); await settle();
    check(!host.querySelector(".inspector-font-error"), "revoked capability displayed a late error");
    capable = true; await render(); await click(".inspector-font-read"); await resolveLatest({ ...healthy, ref: "TextView@b" });
    const panel = get(".floating-inspector"); check(panel.scrollWidth <= panel.clientWidth + 1, "248px panel overflows");
    check(!get(".inspector-font-result dt").querySelector("button"), "copy button crowds the label");
    check(JSON.stringify(root) === original, "font read modified the saved snapshot");
    await click(".inspector-font-read"); flushSync(() => renderer.unmount()); await settle();
    check(canceled.at(-1) === "live-c", "unmount did not cancel font read"); reads.at(-1)!.resolve({ ...healthy, ref: "TextView@b" }); await settle();
    return { checks: ["explicit single read", "font facts and unsupported names", "search/copy without reads", "failure retry", "node/snapshot/session/capability late results", "cancel before replacement", "offline and unmount", "248px layout and unchanged snapshot"], explicitReads: reads.length, implicitReads: 0 };
  } finally { if (host.querySelector(".floating-inspector")) flushSync(() => renderer.unmount()); host.remove(); }
}
