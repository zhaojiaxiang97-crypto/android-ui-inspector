import type { UiSnapshot } from "../shared/types";
import { diagnosisHandoffFixture } from "./diagnosis-handoff-fixture";
import { COLOR_ALIAS_STORAGE_KEY } from "../shared/inspector-colors";
import { makeNode } from "./fixtures";

export function propertiesFixture(image: string) {
  const snapshot = diagnosisHandoffFixture(image), root = snapshot.root!;
  const parent = root.children[0], node = parent.children[0];
  parent.text = "播放偏好设置父容器 / ".repeat(18).trim();
  parent.className = "com.example.benchmark.widgets.ParentPreferenceContainer";
  node.text = "播放偏好设置：长名称仍能查看位置和尺寸 / ".repeat(18).trim();
  node.className = "com.example.benchmark.widgets.PlaybackPreferenceCategoryWithLongClassName";
  node.resourceId = "com.example.benchmark:id/playback_preference_with_a_complete_resource_identifier";
  node.contentDesc = "仅用于本地检查的完整内容描述";
  node.layerImageStatus = "unavailable";
  node.attributes = {
    "tree-source": "debug-sdk", "sdk-class-hierarchy": `${node.className} → android.widget.TextView → android.view.View`,
    "padding-top": "0", "padding-right": "invalid", "padding-bottom": "4.5", "padding-left": "8",
    "sdk-marginTop": "0", "sdk-marginRight": "invalid", "sdk-marginBottom": "-4", "sdk-marginLeft": "",
    "sdk-layout-width": "-1", "sdk-layout-height": "invalid", "sdk-layout-gravity": "",
    "sdk-layout-rules": JSON.stringify({ type: "ConstraintLayout", rules: { horizontalBias: "0.25", verticalBias: "", circleAngle: "invalid", dimensionRatio: "W,16:9", topToTop: "parent" } }),
    "image-capture-error": "未返回该控件的独立位图；透明度未知",
  };
  const empty = root.children[1];
  empty.className = empty.resourceId = empty.text = empty.contentDesc = null;
  empty.bounds = null; empty.attributes = {};
  root.children.push({ ...makeNode("0/2"), className: "QQuickRectangle", text: "QML 颜色合成样例", layerImageStatus: "style",
    attributes: { "inspection-source": "debug-qml", "background-color": "rgba(18,52,86,0.5)", "border-color": "rgba(20,40,60,0)",
      "border-status": "默认边框启用状态未暴露", "corner-radii": "0 / 0 / 0 / 0" } });
  root.children.push({ ...makeNode("0/3"), className: "QQuickRectangle", text: "QML 未知颜色合成样例", layerImageStatus: "style",
    attributes: { "inspection-source": "debug-qml", "background-color": "未暴露", "border-color": "rgba(300,0,0,1)" } });
  root.children.push({ ...makeNode("0/4"), text: "未知来源合成样例", layerImageStatus: "style",
    attributes: { "background-color": "rgba(18,52,86,0.5)", "border-color": "#80123456" } });
  snapshot.nodeCount = 7;
  return snapshot;
}

const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`Properties: ${message}`); }
function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector); assert(value, `missing ${selector}`); return value;
}

export async function verifyWorkbenchProperties(act: (action: () => void) => void, snapshot: UiSnapshot, copied: string[] | (() => string[]), failCopy: (value: boolean) => void, holdCopy: () => () => void) {
  const oldAliases = localStorage.getItem(COLOR_ALIAS_STORAGE_KEY);
  try { return await verifyProperties(act, snapshot, copied, failCopy, holdCopy); }
  finally {
    if (oldAliases === null) localStorage.removeItem(COLOR_ALIAS_STORAGE_KEY); else localStorage.setItem(COLOR_ALIAS_STORAGE_KEY, oldAliases);
  }
}

async function verifyProperties(act: (action: () => void) => void, snapshot: UiSnapshot, copied: string[] | (() => string[]), failCopy: (value: boolean) => void, holdCopy: () => () => void) {
  const copiedValues = () => typeof copied === "function" ? copied() : copied;
  const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
  const until = async (condition: () => boolean) => {
    const end = performance.now() + 4000;
    while (!condition()) { assert(performance.now() < end, "UI did not settle"); await tick(); }
  };
  const click = async (selector: string) => { act(() => element(selector).click()); await settle(); };
  const input = async (selector: string, value: string) => {
    const field = element<HTMLInputElement | HTMLTextAreaElement>(selector);
    act(() => {
      const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }); await settle();
  };
  const node = snapshot.root!.children[0].children[0];
  await until(() => document.querySelector<HTMLElement>(".home-view")?.dataset.state === "connected");
  const reportButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "测试报告");
  assert(reportButton, "report entry missing");
  const menu = reportButton.closest<HTMLDetailsElement>(".workbench-utilities");
  if (menu && !menu.open) { act(() => menu.querySelector("summary")!.click()); await settle(); }
  act(() => reportButton.click());
  await until(() => Boolean(document.querySelector<HTMLDialogElement>(".test-report-dialog")?.open));
  element<HTMLDetailsElement>(".test-report-live").open = true;
  await input(".test-report-live form input", "com.example.benchmark");
  await click(".test-report-live button[type=submit]");
  await until(() => Boolean(document.querySelector(".test-report-live-nodes button:not([disabled])")));
  const target = [...document.querySelectorAll<HTMLButtonElement>(".test-report-live-nodes button")].find(button => button.querySelector("strong")?.textContent === node.text);
  assert(target, "long-name diagnosis node missing"); act(() => target.click()); await settle();
  const panel = element(".floating-inspector"), body = element(".inspector-body"), search = ".inspector-search input";
  assert(panel.dataset.nodeId === node.id && element(".inspector-node-heading h4").title === node.text, "node identity changed or full name lost");

  if (element<HTMLDetailsElement>(".inspector-type").open) await click(".inspector-type > summary");
  const geometryBefore = element(".inspector-geometry").getBoundingClientRect(), bodyBefore = body.getBoundingClientRect();
  assert(geometryBefore.top >= bodyBefore.top && geometryBefore.bottom <= bodyBefore.bottom && document.querySelectorAll(".inspector-geometry").length === 1,
    "summary geometry is duplicated or outside the first viewport");
  await input(search, "PlaybackPreferenceCategoryWithLongClassName");
  assert(element<HTMLDetailsElement>(".inspector-type").open, "search kept the matching type card closed");
  await input(search, node.contentDesc!);
  assert(element<HTMLDetailsElement>(".inspector-identity").open, "matched nested text remains hidden");
  await click(".inspector-search button");
  assert(!element<HTMLDetailsElement>(".inspector-type").open && !element<HTMLDetailsElement>(".inspector-identity").open, "clearing search changed saved disclosure states");
  await click(".inspector-type > summary");
  await input(search, "padding");
  assert(element<HTMLDetailsElement>(".inspector-padding").open && element(".box-model-card").getBoundingClientRect().height > 0, "matched padding remains hidden");
  act(() => element(search).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); await settle();
  assert(!element<HTMLInputElement>(search).value && !panel.hidden && !element<HTMLDetailsElement>(".inspector-padding").open, "Escape did not restore search and disclosure");
  await input(search, "25%");
  assert(!element(".inspector-layout").hidden && element<HTMLDetailsElement>(".inspector-layout-rules").open, "displayed layout-rule value cannot be searched");
  await click(".inspector-search button");
  await input(search, "android.view.View");
  assert(element<HTMLDetailsElement>(".inspector-identity").open && element<HTMLDetailsElement>(".inspector-class-chain").open
    && element(".inspector-class-chain > summary").getBoundingClientRect().height > 0, "searched ancestor is hidden behind its parent disclosure");
  await click(".inspector-search button");
  await input(search, "sdk-layout-height");
  assert(element<HTMLDetailsElement>(".inspector-more").open && element(".node-attributes-list").getBoundingClientRect().height > 0, "matched raw attributes remain collapsed");
  await click(".inspector-search button");

  const values = (selector: string) => [...document.querySelectorAll(`${selector} dd`)].map(value => value.textContent);
  const initialGeometry = values(".inspector-geometry");
  assert(JSON.stringify(initialGeometry) === JSON.stringify(["24", "72", "276", "52"]), "long content changed geometry");
  assert(element(".inspector-type").getBoundingClientRect().height < 180, "identity details crowd the default type card");
  assert(body.scrollWidth <= body.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth, "long content causes horizontal overflow");
  for (const width of [296, 248]) {
    panel.style.width = `${width}px`; await settle();
    assert(body.scrollWidth <= body.clientWidth + 1, "narrow properties overflow horizontally");
    const heading = element(".inspector-node-heading h4"), copy = element(".inspector-copy");
    assert(heading.getBoundingClientRect().right <= copy.getBoundingClientRect().left && heading.title === node.text, "long heading covers copy or loses its full name");
    const geometry = element(".inspector-geometry"); geometry.scrollIntoView({ block: "nearest" }); await settle();
    const box = geometry.getBoundingClientRect(), view = body.getBoundingClientRect();
    assert(box.top >= view.top - 1 && box.bottom <= view.bottom + 1 && panel.contains(document.elementFromPoint(box.left + 10, box.top + 10)), "geometry is not scrollable and reachable");
  }
  panel.style.removeProperty("width"); body.scrollTop = 0; await settle();
  for (const [label, value] of [["类名", node.className!], ["资源 ID", node.resourceId!]]) {
    const button = element<HTMLButtonElement>(`[aria-label="复制${label}"]`); button.scrollIntoView({ block: "nearest" }); await settle(); button.focus();
    const rect = button.getBoundingClientRect();
    assert(document.activeElement === button && panel.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)), "field copy is unreachable");
    await click(`[aria-label="复制${label}"]`);
    assert(copiedValues().at(-1) === value && element(".inspector-copy-status").textContent === `${label} 已复制`, "field copy omitted the full value or feedback");
  }
  failCopy(true); await click('[aria-label="复制类名"]'); failCopy(false);
  assert(element(".inspector-copy-status").textContent === "类名 复制失败", "copy failure reports success");
  await click(".inspector-copy");
  assert(JSON.parse(copiedValues().at(-1)!).id === node.id, "existing JSON copy no longer uses the selected node");
  const releaseEarlierCopy = holdCopy();
  await click('[aria-label="复制类名"]');
  await click('[aria-label="复制资源 ID"]');
  releaseEarlierCopy(); await settle();
  assert(element(".inspector-copy-status").textContent === "资源 ID 已复制", "older copy feedback replaced the newest action");
  if (!element<HTMLDetailsElement>(".inspector-layout").open) await click(".inspector-layout > summary");
  await click(".inspector-padding > summary");
  assert(element(".box-model-extra > div:first-child dd").textContent === "0px / — / -4px / —", "unknown margins became zero or discarded known sides");
  const missingImage = element('.node-presentation-fact[data-node-status="missing"]');
  assert(missingImage.querySelector(".inspector-image-state strong")?.textContent === "画面未提供"
    && missingImage.querySelector(".node-presentation-detail")?.textContent?.includes("不代表控件透明"), "missing image was labeled transparent");
  await click(".inspector-layout-rules > summary");
  const gravity = [...document.querySelectorAll(".inspector-layout-rules dt")].find(item => item.textContent === "重力方向");
  assert(gravity?.nextElementSibling?.textContent === "—", "empty gravity became a measured zero");
  const rule = (name: string) => [...document.querySelectorAll(".inspector-layout-rules dt")].find(item => item.textContent === name)?.nextElementSibling?.textContent;
  assert(rule("垂直偏置") === "—" && rule("环绕角度") === "—" && rule("宽高比") === "W,16:9", "empty/invalid rules gained units or the ratio lost its first component");
  const dimensions = [...document.querySelectorAll(".inspector-extra-geometry dt")].find(item => item.textContent === "布局宽 / 高");
  assert(dimensions?.nextElementSibling?.textContent === "match_parent / —", "invalid layout size gained a unit or erased a valid size");
  await input(search, snapshot.root!.children[0].className!);
  assert(element<HTMLDetailsElement>(".inspector-parent-details").open, "full parent identity is not searchable");
  await click('[aria-label="复制父节点 ID"]');
  assert(copiedValues().at(-1) === snapshot.root!.children[0].id, "parent copy used the selected child ID");
  await click(".inspector-search button");
  const releaseCopy = holdCopy();
  await click('[aria-label="复制类名"]');
  await click('.tree-row[data-tree-id="0/1"]');
  releaseCopy(); await settle();
  assert(!document.querySelector(".inspector-copy-status"), "late copy feedback followed selection to another node");
  assert(element(".inspector-class-name").textContent === "—" && !document.querySelector('[aria-label="复制类名"]') && !document.querySelector('[aria-label="复制资源 ID"]'), "absent class/ID retains stale values or copy buttons");
  assert(JSON.stringify(values(".inspector-geometry")) === '["—","—","—","—"]', "unknown geometry became zero");
  await click('.tree-row[data-tree-id="0/0/0"]');
  for (const selector of [".inspector-padding", ".inspector-layout-rules"])
    if (element<HTMLDetailsElement>(selector).open) await click(`${selector} > summary`);
  await click('.tree-row[data-tree-id="0/2"]');
  if (!element<HTMLDetailsElement>(".inspector-image").open) await click(".inspector-image > summary");
  if (!element<HTMLDetailsElement>(".inspector-image-details").open) await click(".inspector-image-details > summary");
  const background = () => element('[data-color-label="背景源色"]');
  const border = () => element('[data-color-label="边框源色"]');
  assert(background().textContent?.includes("≈ #12345680") && background().textContent?.includes("透明度 50%"), "QML alpha was lost or approximate hex was claimed exact");
  assert(background().querySelector<HTMLElement>(".inspector-color-swatch > span")!.style.backgroundColor === "rgba(18, 52, 86, 0.5)", "QML swatch has the wrong channels");
  assert(border().textContent?.includes("#14283C00") && border().querySelector<HTMLElement>(".inspector-color-swatch > span")!.style.backgroundColor === "rgba(20, 40, 60, 0)", "invisible color lost RGB or became opaque");
  assert(getComputedStyle(element(".inspector-color-swatch")).backgroundImage.includes("gradient"), "transparent preview has no checkerboard");
  assert(element(".inspector-image-details").textContent?.includes("默认边框启用状态未暴露"), "color preview removed the border uncertainty");
  for (const [format, expected] of [["原值", "rgba(18,52,86,0.5)"], [" Hex", "#12345680"], [" RGBA", "rgba(18, 52, 86, 0.5)"]]) {
    await click(`[aria-label="复制背景源色${format}"]`);
    assert(copiedValues().at(-1) === expected, "color copy has wrong format or precision");
  }
  failCopy(true); await click('[aria-label="复制背景源色 RGBA"]'); failCopy(false);
  assert(element(".inspector-copy-status").textContent === "背景源色 RGBA 复制失败", "failed color copy claims success");
  await click(".workbench-utilities > summary"); await click("[data-command=preferences]");
  await input('[aria-label="颜色别名"]', "#12345680 = 八位透明度\nrgba(18,52,86,0.5) = 半透明主色\n#14283C00 = 全透明边框");
  await click(".preferences-color-actions button:first-child"); await click(".entry-dialog-close");
  assert(background().querySelector(".inspector-color-alias")?.textContent === "半透明主色" && border().querySelector(".inspector-color-alias")?.textContent === "全透明边框", "aliases did not apply immediately or ignored alpha precision");
  await click(".inspector-image-details > summary"); await click(".inspector-image > summary");
  for (const term of ["半透明主色", "#12345680", "rgba(18, 52, 86, 0.5)"]) {
    await input(search, term);
    assert(!element(".inspector-image").hidden && element<HTMLDetailsElement>(".inspector-image").open && element<HTMLDetailsElement>(".inspector-image-details").open, "color or alias search remains hidden");
    await click(".inspector-search button");
    assert(!element<HTMLDetailsElement>(".inspector-image").open && !element<HTMLDetailsElement>(".inspector-image-details").open, "color search changed manual disclosure");
  }
  await click(".inspector-image > summary"); await click(".inspector-image-details > summary");
  for (const width of [296, 248]) {
    panel.style.width = `${width}px`; await settle();
    assert(body.scrollWidth <= body.clientWidth + 1, "color property overflows narrow inspector");
    const button = element<HTMLButtonElement>('[aria-label="复制背景源色 RGBA"]'); button.scrollIntoView({ block: "nearest" }); button.focus(); await settle();
    const box = button.getBoundingClientRect();
    assert(document.activeElement === button && panel.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)), "color copy is not reachable in a narrow inspector");
  }
  panel.style.removeProperty("width");
  await click('.tree-row[data-tree-id="0/3"]');
  assert(!document.querySelector(".inspector-color-swatch") && !document.querySelector(".inspector-color-alias")
    && element(".inspector-image-details").textContent?.includes("未暴露") && !document.querySelector('[aria-label="复制背景源色 Hex"]'), "unknown color inherited a previous swatch or gained a guessed conversion");
  await click('.tree-row[data-tree-id="0/4"]');
  assert(!document.querySelector(".inspector-color-swatch"), "unknown color source was assumed to be Android or QML");
  await click('.tree-row[data-tree-id="0/0/0"]');
  assert(!document.querySelector(".inspector-color-swatch"), "selected Android snapshot inherited QML colors");
  body.scrollTop = 0; await settle();
  return { scenarios: ["search reveals collapsed, nested and raw content", "clear/Escape restores saved disclosure", "long identity keeps compact geometry and reachable scroll", "complete class/ID/parent/JSON copy with honest failure", "displayed layout and full parent values are searchable", "partial/unknown layout and missing images stay honest", "QML source colors keep alpha, precision and unknown border state", "raw/hex/RGBA copy and failure", "exact local aliases, searchable without altering disclosure", "colors remain reachable at 296/248px and do not leak across nodes"], geometry: initialGeometry, copiedLengths: copiedValues().map(value => value.length), fixtureOnly: true };
}
