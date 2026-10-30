import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import type { UiSnapshot } from "../shared/types";
import { INSPECTOR_GROUP_STORAGE_KEY } from "../shared/inspector-groups";
import { MAX_INSPECTOR_SEARCH_RESULTS } from "../shared/inspector-search";
import { businessMetadataFixture } from "../tests/fixtures/debug-metadata";
import { makeNode } from "./fixtures";

export async function verifyInspectorPropertySearch() {
  const previousApi = window.electronApi, previousMedia = window.matchMedia;
  const storageBefore = Array.from({ length: localStorage.length }, (_, index) => {
    const key = localStorage.key(index)!; return [key, localStorage.getItem(key)!] as const;
  });
  const host = document.createElement("div"); document.body.append(host);
  const app = createRoot(host);
  let mounted = true, reducedMotion = true, captures = 0;
  const copies: string[] = [], extraDeviceReads: string[] = [];
  const check = (value: unknown, message: string) => { if (!value) throw new Error(`Inspector property search: ${message}`); };
  const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const until = async (predicate: () => boolean, label: string) => {
    const deadline = performance.now() + 4000;
    while (!predicate()) { if (performance.now() > deadline) throw new Error(`Inspector property search timeout: ${label}`); await tick(); }
  };
  const click = (selector: string) => {
    const control = host.querySelector<HTMLElement>(selector);
    check(control && !(control instanceof HTMLButtonElement && control.disabled), `control unavailable: ${selector}`);
    flushSync(() => control!.click());
  };
  const longValue = "  完整业务原值\n" + "完整业务原值_".repeat(40) + "UNIQUE_LONG_TAIL\n  ";
  const longText = "  控件完整文本\n" + "换行阅读样例\n".repeat(18) + "TEXT_LONG_TAIL  ";
  const longDescription = "  完整描述\n" + "description_".repeat(35) + "DESC_LONG_TAIL\n  ";
  const longSummary = "  业务父节点原值\n" + "父节点多行原值\n".repeat(18) + "SUMMARY_LONG_TAIL  ";
  const longRawValue = "  完整原始属性\n" + "原始属性换行阅读\n".repeat(18) + "RAW_LONG_TAIL\n  ";
  const metadata = structuredClone(businessMetadataFixture);
  metadata.groups[1].fields.find(field => field.key === "detail")!.value = longValue;
  metadata.version = 2;
  metadata.groups[1].fields.push({ key: "longTree", label: "长值树", type: "tree", value: [{
    key: "summary", label: "长说明", type: "string", value: longSummary,
    children: [{ key: "child", label: "子项", type: "boolean", value: false, children: [] }],
  }] });
  const fixture: UiSnapshot = {
    serial: "property-search-fixture", nodeCount: 3, xmlSize: 0, rawXml: null, screenshotDataUrl: null, warning: null, error: null,
    root: { ...makeNode("0"), text: "搜索样例父容器", children: [
      { ...makeNode("0/0", 1), className: "org.example.SearchTargetWidget", text: longText, contentDesc: longDescription, package: "org.example." + "longpackage_".repeat(25), debugMetadata: metadata,
        layerImageStatus: "style", attributes: {
          "inspection-source": "debug-qml", "background-color": "  #12345678  ", "border-color": "#87654321", "border-status": "已读取", "border-width": "0",
          hint: "  原始提示  ", "corner-radii": "4,4,4,4", "image-refreshed-at": "2026-10-11T12:00:00.000Z",
          "sdk-class-hierarchy": "org.example.SearchTargetWidget → android.view.View", "sdk-longClickable": "false", "sdk-hasOnClickListeners": "false",
          "sdk-layout-weight": "0", "sdk-layout-gravity": "85", "padding-left": "0", "raw-empty": "", "raw-false": "false", "raw-long": longRawValue,
          ...Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`raw-match-${index}`, `search-bounded-${index}`])),
        } },
      { ...makeNode("0/1", 2), text: "另一个控件" },
    ] },
  };
  window.matchMedia = query => {
    const media = previousMedia.call(window, query);
    if (query !== "(prefers-reduced-motion: reduce)") return media;
    return new Proxy(media, { get: (target, key) => key === "matches" ? reducedMotion : typeof Reflect.get(target, key, target) === "function"
      ? Reflect.get(target, key, target).bind(target) : Reflect.get(target, key, target) });
  };
  window.electronApi = {
    runtime: { sandboxed: true, contextIsolated: true },
    probeAdb: async () => ({ adbPath: "fixture", adbVersion: "fixture", error: null, devices: [{ serial: fixture.serial, state: "device", model: "fixture", androidVersion: "15", product: null, transportId: null }] }),
    inspectDevice: async () => { captures++; return structuredClone(fixture); },
    captureGroup: async () => { extraDeviceReads.push("group"); throw new Error("Unexpected group capture in property search"); },
    refreshViewNode: async () => { extraDeviceReads.push("refresh"); throw new Error("Unexpected node refresh in property search"); },
    readViewStyle: async () => { extraDeviceReads.push("style"); throw new Error("Unexpected style read in property search"); },
    cancelInspection: async () => {}, showLayerMenu: async () => null,
    onInspectionProgress: () => () => {}, onInspectionPreview: () => () => {},
    copyText: async value => { copies.push(value); }, loadSnapshots: async () => ({ snapshots: [], error: null }),
    exportSnapshot: async () => ({ canceled: true, filePath: null, error: null }),
    saveSnapshot: async () => ({ snapshots: [], error: null }), clearSnapshots: async () => ({ snapshots: [], error: null }),
  };
  const panel = () => host.querySelector<HTMLElement>(".floating-inspector")!;
  const body = () => panel().querySelector<HTMLElement>(".inspector-body")!;
  const search = () => panel().querySelector<HTMLInputElement>(".inspector-search input")!;
  const card = (name: string) => panel().querySelector<HTMLDetailsElement>(`.inspector-${name}`)!;
  const filter = (value: string) => flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search(), value);
    search().dispatchEvent(new Event("input", { bubbles: true }));
  });
  const result = (label: string, group?: string) => [...panel().querySelectorAll<HTMLButtonElement>(".inspector-search-result")]
    .find(button => button.querySelector("strong")?.textContent === label && (!group || button.querySelector("small")?.textContent?.startsWith(group)));
  const locate = async (label: string, group?: string, keyboard = false) => {
    const button = result(label, group); check(button, `missing concrete result ${group ?? ""} ${label}`);
    flushSync(() => {
      if (keyboard) { button!.focus({ preventScroll: true }); button!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); }
      else button!.click();
    });
    await until(() => Boolean(panel().querySelector(".inspector-property-highlight")), `highlight ${label}`);
    return panel().querySelector<HTMLElement>(".inspector-property-highlight")!;
  };
  const readableValue = (row: HTMLElement, original: string, label: string) => {
    const content = row.querySelector<HTMLElement>(".long-text-content")!;
    const indexedValue = row.dataset.inspectorValue ?? row.querySelector(":scope > dd")?.getAttribute("title");
    check(content && content.textContent === original && indexedValue === original, `${label} display/index changed the full original value`);
    const style = getComputedStyle(content);
    check(style.whiteSpace === "pre-wrap" && style.userSelect === "text" && content.tabIndex === 0,
      `${label} lost whitespace, text selection or keyboard access`);
    check(content.clientHeight > 0 && content.getBoundingClientRect().height <= 136 && content.scrollHeight > content.clientHeight
      && content.scrollWidth <= content.clientWidth + 1, `${label} is not bounded and scrollable`);
    const selection = window.getSelection()!;
    selection.selectAllChildren(content);
    check(selection.toString() === original, `${label} cannot select the complete value including whitespace`);
    selection.removeAllRanges();
    content.scrollTop = content.scrollHeight;
    check(content.scrollTop > 0, `${label} cannot scroll to its tail`);
    content.scrollTop = 0;
    return content;
  };
  const capture = async () => {
    const before = captures; click(".capture-button");
    await until(() => captures === before + 1 && Boolean(host.querySelector('.tree-row[data-tree-id="0/0"]')) && !host.querySelector(".inspection-progress"), "new snapshot");
    click('.tree-row[data-tree-id="0/0"]');
  };
  try {
    localStorage.clear();
    flushSync(() => app.render(<App />));
    await until(() => Boolean(host.querySelector<HTMLButtonElement>(".capture-button") && !host.querySelector<HTMLButtonElement>(".capture-button")!.disabled), "capture ready");
    await capture();
    const originalBody = body(), scrollCalls: ScrollToOptions[] = [], originalScrollTo = originalBody.scrollTo;
    originalBody.scrollTo = function(options: ScrollToOptions | number = {}, y?: number) {
      if (typeof options === "number") return originalScrollTo.call(this, options, y ?? 0);
      scrollCalls.push(options); Reflect.apply(originalScrollTo, this, [options]);
    };
    const treeScroll = host.querySelector<HTMLElement>(".tree-scroll"), treeTop = treeScroll?.scrollTop, windowTop = window.scrollY;
    if (card("type").open) click(".inspector-type > summary");
    click(".inspector-business .inspector-business-group > summary");
    click(".inspector-business > summary");
    click('[aria-label="设置属性分组"]');
    for (const name of ["类型", "业务信息", "布局", "原始属性"]) click(`[aria-label="显示${name}"]`);
    click('[aria-label="关闭偏好设置"]');
    const savedPreferences = localStorage.getItem(INSPECTOR_GROUP_STORAGE_KEY);
    search().focus({ preventScroll: true });
    filter("SearchTargetWidget");
    check(!card("type").hidden && result("完整类名", "类型") && document.activeElement === search() && scrollCalls.length === 0,
      "typing did not reveal a real name/value result, stole input focus or scrolled the inspector");
    click(".inspector-type > summary");
    const classRow = await locate("完整类名", "类型", true);
    check(classRow.querySelector("dt")?.textContent === "完整类名" && card("type").open && card("identity").open,
      "keyboard result did not reveal and locate the exact property row");
    check(scrollCalls.at(-1)?.behavior === "instant" && treeScroll?.scrollTop === treeTop && window.scrollY === windowTop,
      "reduced motion used animated scrolling or moved a different scroll container");
    filter("");
    check(card("type").hidden && !card("type").open && !card("identity").open && !panel().querySelector(".inspector-property-highlight"),
      "clearing search retained target highlight, hidden group or temporary disclosure");

    filter("android.view.View");
    click(".inspector-class-chain > summary");
    const inheritance = await locate("父类", "类型");
    check(inheritance.querySelector("dd")?.textContent === "android.view.View" && card("class-chain").open && card("identity").open, "deep inherited class target stayed folded");
    filter("UNIQUE_LONG_TAIL");
    const longResult = result("详情", "业务信息")!;
    check(longResult && longResult.querySelector("span")!.textContent!.length <= 101 && !longResult.querySelector("span")!.textContent!.includes("UNIQUE_LONG_TAIL"), "long result was not bounded or full tail was unsearchable");
    flushSync(() => longResult.parentElement!.querySelector<HTMLButtonElement>(".inspector-search-result-copy")!.click());
    await until(() => copies.at(-1) === longValue, "complete long original value copy");
    const longBusinessRow = await locate("详情", "业务信息");
    readableValue(longBusinessRow, longValue, "business string");
    flushSync(() => longBusinessRow.querySelector<HTMLButtonElement>(".inspector-field-copy")!.click());
    await until(() => copies.at(-1) === longValue, "business field retains whitespace when copying");
    filter("TEXT_LONG_TAIL");
    const textRow = await locate("文本", "类型");
    readableValue(textRow, longText, "node text");
    flushSync(() => textRow.querySelector<HTMLButtonElement>(".inspector-field-copy")!.click());
    await until(() => copies.at(-1) === longText, "node text field copies its full original");
    filter("DESC_LONG_TAIL");
    const descriptionRow = await locate("描述", "类型");
    readableValue(descriptionRow, longDescription, "node description");
    flushSync(() => descriptionRow.querySelector<HTMLButtonElement>(".inspector-field-copy")!.click());
    await until(() => copies.at(-1) === longDescription, "description field copies its full original");
    filter("SUMMARY_LONG_TAIL");
    const summaryRow = await locate("长说明", "业务信息");
    const branch = summaryRow.parentElement as HTMLDetailsElement;
    const summaryValue = readableValue(summaryRow, longSummary, "business parent string");
    const branchOpen = branch.open;
    flushSync(() => summaryValue.click());
    check(branch.open === branchOpen, "reading the business parent value toggled its branch");
    flushSync(() => summaryRow.querySelector<HTMLButtonElement>(".inspector-field-copy")!.click());
    await until(() => copies.at(-1) === longSummary, "business parent field copies its full original");
    check(branch.open === branchOpen, "copying the business parent value toggled its branch");
    flushSync(() => summaryRow.click());
    check(branch.open !== branchOpen, "business parent summary no longer toggles from its label area");
    filter("SearchTargetWidget");
    const shortClass = await locate("完整类名", "类型");
    check(shortClass.querySelector(".long-text-content")?.tagName === "SPAN" && !shortClass.querySelector(".long-text-value,.inspector-field-copy"),
      "short basic values gained long-value controls");
    filter("retryCount"); await locate("重试次数", "业务信息");
    check(result("重试次数", "业务信息")?.querySelector("span")?.textContent === "0", "zero became missing in results");
    filter("false"); await locate("加载中", "业务信息");
    check(result("加载中", "业务信息")?.querySelector("span")?.textContent === "false" && result("可长按", "交互"), "boolean original values were lost or only translated strings were indexed");
    filter("空字符串");
    check(result("错误信息", "业务信息") && result("raw-empty", "原始属性"), "empty business/raw values were not searchable");
    const empty = result("错误信息", "业务信息")!;
    flushSync(() => empty.parentElement!.querySelector<HTMLButtonElement>(".inspector-search-result-copy")!.click());
    await until(() => copies.at(-1) === "", "empty original value copy");
    filter("#12345678");
    const color = result("背景源色", "画面")!; check(color, "real QML colour field was missing");
    flushSync(() => color.parentElement!.querySelector<HTMLButtonElement>(".inspector-search-result-copy")!.click());
    await until(() => copies.at(-1) === "  #12345678  ", "colour original retains whitespace and excludes decoration");
    const colorRow = await locate("背景源色", "画面");
    check(colorRow.dataset.colorLabel === "背景源色" && card("image-details").open, "colour target was not its real colour row");
    for (const [query, label, group, original] of [
      ["原始提示", "提示", "类型", "  原始提示  "],
      ["圆角", "圆角", "画面", "4,4,4,4"],
      ["刷新时间", "刷新时间", "画面", "2026-10-11T12:00:00.000Z"],
    ]) {
      filter(query); const button = result(label, group)!; check(button, `missing original source ${label}`);
      flushSync(() => button.parentElement!.querySelector<HTMLButtonElement>(".inspector-search-result-copy")!.click());
      await until(() => copies.at(-1) === original, `source whitespace/units/time preserved for ${label}`);
    }
    await locate("刷新时间", "画面", true);
    flushSync(() => result("刷新时间", "画面")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    check(!search().value && !panel().hidden && document.activeElement === search() && !panel().querySelector(".inspector-property-highlight"), "Escape from a result did not clear and return to the search input");
    filter("布局权重");
    const weightRow = await locate("布局权重", "布局");
    check(weightRow.querySelector("dd")?.textContent === "0" && card("layout-rules").open && !card("layout").hidden, "hidden native-layout row was not located");

    filter("search-bounded");
    check(panel().querySelectorAll(".inspector-search-result").length === MAX_INSPECTOR_SEARCH_RESULTS && panel().querySelector('.inspector-search-results > p')?.textContent === "匹配 40 项，显示前 30 项", "result cap hid the true match count");
    filter("raw-match-39");
    const rawRow = await locate("raw-match-39", "原始属性");
    check(rawRow.querySelector("dd")?.getAttribute("title") === "search-bounded-39" && card("more").open && !card("more").hidden, "deep raw property result did not reveal the real original row");
    filter("UiSelector");
    const selectorRow = await locate("UiSelector", "原始属性");
    check(selectorRow.classList.contains("selector-row") && selectorRow.querySelector("code")?.textContent?.includes("UiSelector"), "real locator value did not locate its code row");
    filter("复制节点 JSON");
    check(panel().querySelectorAll(".inspector-search-result").length === 0 && panel().querySelector('.inspector-search-results > p')?.textContent === "匹配 0 项", "copy button decoration became a property result");
    for (const width of [300, 248]) {
      panel().style.width = `${width}px`; filter("UNIQUE_LONG_TAIL"); await tick();
      const list = panel().querySelector<HTMLElement>(".inspector-search-results")!;
      check(list.scrollWidth <= list.clientWidth + 1 && body().scrollWidth <= panel().clientWidth + 1
        && [...list.querySelectorAll<HTMLElement>("button")].every(button => button.getBoundingClientRect().right <= list.getBoundingClientRect().right + 1), `result controls overflowed at ${width}px`);
      readableValue(await locate("详情", "业务信息", true), longValue, `business at ${width}px`);
      filter("TEXT_LONG_TAIL"); readableValue(await locate("文本", "类型"), longText, `text at ${width}px`);
      filter("DESC_LONG_TAIL"); readableValue(await locate("描述", "类型"), longDescription, `description at ${width}px`);
      filter("SUMMARY_LONG_TAIL");
      const summary = await locate("长说明", "业务信息");
      const value = readableValue(summary, longSummary, `parent at ${width}px`);
      const branch = summary.parentElement as HTMLDetailsElement, wasOpen = branch.open;
      flushSync(() => value.click()); check(branch.open === wasOpen, `parent text toggles at ${width}px`);
      check(body().scrollWidth <= panel().clientWidth + 1
        && [...panel().querySelectorAll<HTMLElement>(".inspector-field-copy")].filter(button => button.getClientRects().length)
          .every(button => button.getBoundingClientRect().right <= panel().getBoundingClientRect().right + 1), `long-value controls overflowed at ${width}px`);
      filter("RAW_LONG_TAIL");
      const rawLongRow = await locate("raw-long", "原始属性", true);
      const rawContent = readableValue(rawLongRow, longRawValue, `raw attribute at ${width}px`);
      const rawValue = rawLongRow.querySelector<HTMLElement>(":scope > dd")!;
      const rawCopy = rawValue.querySelector<HTMLButtonElement>(".inspector-field-copy")!;
      check(getComputedStyle(rawValue.querySelector<HTMLElement>(".long-text-value")!).display === "flex"
        && rawValue.scrollWidth <= rawValue.clientWidth + 1 && body().scrollWidth <= panel().clientWidth + 1
        && rawContent.getBoundingClientRect().right <= rawCopy.getBoundingClientRect().left + 1
        && rawCopy.getBoundingClientRect().right <= rawValue.getBoundingClientRect().right + 1,
        `raw long-value layout overflowed or overlapped its copy control at ${width}px`);
      const rawCopiesBefore = copies.length;
      flushSync(() => rawCopy.click());
      await until(() => copies.length === rawCopiesBefore + 1 && copies.at(-1) === longRawValue, `raw field original copy at ${width}px`);
      flushSync(() => result("raw-long", "原始属性")!.parentElement!.querySelector<HTMLButtonElement>(".inspector-search-result-copy")!.click());
      await until(() => copies.length === rawCopiesBefore + 2 && copies.at(-1) === longRawValue, `raw tail result original copy at ${width}px`);
      filter("raw-empty");
      const rawEmptyRow = await locate("raw-empty", "原始属性");
      const rawEmptyValue = rawEmptyRow.querySelector<HTMLElement>(":scope > dd")!;
      check(rawEmptyValue.getAttribute("title") === "" && rawEmptyValue.textContent === "∅"
        && rawEmptyValue.querySelector(".long-text-content")?.tagName === "SPAN"
        && !rawEmptyValue.querySelector(".long-text-value,.inspector-field-copy")
        && rawEmptyValue.scrollWidth <= rawEmptyValue.clientWidth + 1,
        `raw empty value lost its compact placeholder or original at ${width}px`);
      const emptyCopiesBefore = copies.length;
      flushSync(() => result("raw-empty", "原始属性")!.parentElement!.querySelector<HTMLButtonElement>(".inspector-search-result-copy")!.click());
      await until(() => copies.length === emptyCopiesBefore + 1 && copies.at(-1) === "", `raw empty result copies original rather than placeholder at ${width}px`);
      filter("LONG_TAIL"); await locate("文本", "类型");
      await (window as typeof window & { lookinMigrationVisualCheckpoint?: (name: string) => Promise<void> }).lookinMigrationVisualCheckpoint?.(`long-text-${width}`);
    }
    panel().style.removeProperty("width");
    filter("UNIQUE_LONG_TAIL");
    await locate("详情", "业务信息");
    click(".inspector-collapse");
    check(!panel().querySelector(".inspector-property-highlight"), "panel collapse retained highlight");
    click(".inspector-collapse"); await tick();
    check(!panel().querySelector(".inspector-property-highlight"), "reopening collapsed panel replayed a stale target");
    await locate("详情", "业务信息"); click(".inspector-close");
    check(!panel().querySelector(".inspector-property-highlight"), "closed panel retained highlight");
    click(".inspector-toggle"); await tick();
    check(!panel().querySelector(".inspector-property-highlight"), "reopened panel replayed a stale target");
    reducedMotion = false; const highlightStart = performance.now(); await locate("详情", "业务信息");
    check(scrollCalls.at(-1)?.behavior === "smooth", "explicit result never used the normal short scroll transition");
    await until(() => !panel().querySelector(".inspector-property-highlight"), "highlight expires");
    check(performance.now() - highlightStart >= 1400, "target highlight vanished before it could be seen");
    const staleResult = result("详情", "业务信息")!;
    await locate("详情", "业务信息");
    click('.tree-row[data-tree-id="0/1"]');
    check(!panel().querySelector(".inspector-property-highlight") && !result("详情", "业务信息"), "changing node retained old result/highlight");
    flushSync(() => staleResult.click()); await tick();
    check(!panel().querySelector(".inspector-property-highlight"), "old detached result located another node");
    click('.tree-row[data-tree-id="0/0"]'); filter("UNIQUE_LONG_TAIL");
    await locate("详情", "业务信息");
    await capture(); await tick();
    check(!panel().querySelector(".inspector-property-highlight"), "same-ID new snapshot received an old highlight");
    filter("");
    const freshDisclosure = { type: card("type").open, business: card("business").open };
    filter("UNIQUE_LONG_TAIL"); await locate("详情", "业务信息");
    filter("another-unmatched-property"); await tick();
    check(!panel().querySelector(".inspector-property-highlight"), "changing query retained an obsolete target");
    filter("UNIQUE_LONG_TAIL");
    flushSync(() => search().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    check(!search().value && card("type").hidden && card("type").open === freshDisclosure.type && card("business").hidden && card("business").open === freshDisclosure.business
      && localStorage.getItem(INSPECTOR_GROUP_STORAGE_KEY) === savedPreferences && !panel().hidden, `Escape changed user disclosure, persistent groups or closed the panel: ${JSON.stringify({ query: search().value, typeHidden: card("type").hidden, typeOpen: card("type").open, businessHidden: card("business").hidden, businessOpen: card("business").open, preferencesRetained: localStorage.getItem(INSPECTOR_GROUP_STORAGE_KEY) === savedPreferences, panelHidden: panel().hidden })}`);
    filter("UNIQUE_LONG_TAIL"); await locate("详情", "业务信息");
    const unmountedTarget = panel().querySelector<HTMLElement>(".inspector-property-highlight")!;
    flushSync(() => app.unmount()); mounted = false;
    check(!unmountedTarget.classList.contains("inspector-property-highlight") && extraDeviceReads.length === 0, "unmount retained target/timer or search caused extra device reads");
    return ["name/value results locate exact rows, deep ancestors and keyboard Enter; typing keeps input focus and scroll position",
      "hidden/manual disclosure and persistent visibility restored by clear/Escape; zero/false/empty and full long original values remain searchable/copyable",
      "real colour/layout/raw targets exclude action labels; all matches counted with first 30 shown",
      "long text/description/business/raw values retain whitespace, select fully and scroll within a bounded height at 300/248px; raw empty placeholders copy the empty original",
      "explicit inspector-only scroll, reduced motion, short highlight and close/collapse/unmount cleanup",
      "query/node/same-ID snapshot changes invalidate stale results and targets; zero extra group/style/refresh requests"];
  } finally {
    if (mounted) flushSync(() => app.unmount());
    window.electronApi = previousApi; window.matchMedia = previousMedia;
    localStorage.clear(); for (const [key, value] of storageBefore) localStorage.setItem(key, value);
    host.remove();
  }
}
