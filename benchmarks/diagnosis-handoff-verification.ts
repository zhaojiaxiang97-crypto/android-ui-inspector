// DOM checks shared by the source harness and actual candidate renderer. No App/React bundle here.
export type HandoffAudit = { captures: number; writes: number; deviceActions: number; sourceUnchanged: boolean };
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 4000;
  while (!predicate()) { assert(performance.now() < deadline, message); await tick(); }
}
function element<T extends HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector); assert(value, `Missing ${selector}`); return value;
}

export async function verifyDiagnosisHandoff(readAudit: () => HandoffAudit | Promise<HandoffAudit>, act: (action: () => void) => void = action => action()) {
  async function click(selector: string) { act(() => element<HTMLButtonElement>(selector).click()); await tick(); await tick(); }
  async function input(selector: string, value: string) {
    const field = element<HTMLInputElement>(selector);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    act(() => { field.dispatchEvent(new Event("input", { bubbles: true })); }); await tick(); await tick();
  }
  async function openReport() {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "测试报告");
    assert(button, "Report button missing");
    const menu = button.closest<HTMLDetailsElement>(".workbench-utilities, .home-application-menu");
    if (menu && !menu.open) { act(() => menu.querySelector("summary")!.click()); await tick(); }
    assert(button.getBoundingClientRect().height > 0, "Report button is not reachable");
    act(() => button.click());
    await until(() => Boolean(document.querySelector<HTMLDialogElement>(".test-report-dialog")?.open), "Report did not open");
    element<HTMLDetailsElement>(".test-report-live").open = true;
  }
  async function viewNode(name: string, id: string) {
    const button = [...document.querySelectorAll<HTMLButtonElement>(".test-report-live-nodes button")].find(button => button.querySelector("strong")?.textContent === name);
    assert(button, `Diagnosis node missing: ${name}`); act(() => button.click());
    await until(() => !element<HTMLDialogElement>(".test-report-dialog").open, "Report did not close after selecting diagnosis node");
    await until(() => document.querySelector(".tree-row.selected")?.getAttribute("data-tree-id") === id, "Tree selected the wrong node");
    await tick(); await tick();
    const panel = element<HTMLElement>(".floating-inspector"), body = element<HTMLElement>(".inspector-body");
    assert(!panel.hidden && !body.hidden && !panel.classList.contains("is-collapsed"), "Diagnosis node did not reveal and expand properties");
    if (document.querySelector(".inspection-header")) assert(panel.classList.contains("is-docked"), "Report reveal did not restore right-edge properties");
    assert(panel.dataset.nodeId === id && element(".inspector-node-heading h4").textContent === name, "Properties show the wrong node/name");
    const bounds = panel.getBoundingClientRect();
    assert(bounds.width > 100 && bounds.height > 100 && bounds.top >= 0 && bounds.left >= 0 && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1, "Properties outside visible viewport");
    const heading = element(".inspector-node-heading").getBoundingClientRect();
    const hit = document.elementFromPoint(heading.left + 8, heading.top + 8);
    assert(hit && panel.contains(hit), "Properties heading is clipped or covered");
    assert(element<HTMLInputElement>(".inspector-search input").value === "", "Stale property search hides the selected node fields");
    assert(body.scrollTop === 0, "Properties did not return to the selected node heading");
    assert(document.activeElement === panel.querySelector(".inspector-drag-handle"), "Keyboard focus did not leave the report for properties");
    const geometry = [...document.querySelectorAll(".inspector-geometry dl dd")].slice(0, 4).map(value => value.textContent);
    assert(JSON.stringify(geometry) === JSON.stringify(id === "0/0/0" ? ["24", "72", "276", "52"] : ["24", "140", "312", "56"]), "Properties geometry differs from diagnosis node");
    await until(() => {
      const canvas = element(".screenshot-frame"), workspace = panel.parentElement!;
      return Number.parseFloat(panel.style.getPropertyValue("--inspector-viewport-height")) === Math.min(workspace.clientHeight, canvas.offsetTop + canvas.offsetHeight);
    }, "Inspector still sized against an old canvas");
    const layout = element(".inspector-geometry");
    // Wait for image/toolbar sizing and scroll only the actual inspector, not the workbench.
    await until(() => {
      const beforeScroll = layout.getBoundingClientRect(), viewport = body.getBoundingClientRect();
      if (beforeScroll.bottom > viewport.bottom) body.scrollTop += beforeScroll.bottom - viewport.bottom + 10;
      const bounds = layout.getBoundingClientRect();
      return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
    }, "Geometry fields cannot be scrolled into view");
    await tick();
    const layoutBounds = layout.getBoundingClientRect();
    assert(panel.contains(document.elementFromPoint(layoutBounds.left + 8, layoutBounds.top + 8)), "Geometry fields are clipped or covered");
    body.scrollTop = 0; await tick(); await tick();
    assert(body.scrollTop === 0, "Inspector scroll position changed again after returning to the heading");
    const audit = await readAudit();
    assert(audit.captures === 1 && audit.writes === 0 && audit.deviceActions === 0 && audit.sourceUnchanged, "Local handoff performed another capture/action or mutated history/source");
    return { name, id, rect: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }, geometry };
  }

  await until(() => document.querySelector<HTMLElement>(".home-view")?.dataset.state
    ? document.querySelector<HTMLElement>(".home-view")?.dataset.state === "connected"
    : Boolean(document.querySelector(".device-select option[data-device-state=device]")), "Synthetic device not ready");
  assert(window.electronApi.runtime.sandboxed && window.electronApi.runtime.contextIsolated, "Renderer isolation is disabled");
  await openReport(); await input(".test-report-live form input", "com.example.benchmark"); await click(".test-report-live button[type=submit]");
  await until(() => Boolean(document.querySelector(".test-report-live-nodes button:not([disabled])")), "Synthetic diagnosis not ready");
  const checks: Array<{ scenario: string; result: Awaited<ReturnType<typeof viewNode>> }> = [];
  checks.push({ scenario: "default panel", result: await viewNode("本地设置标题", "0/0/0") });
  await click(".inspector-close"); await until(() => element(".floating-inspector").hidden === true, "Close did not hide panel");
  await click('.tree-row[data-tree-id="0/1"]'); assert(element(".floating-inspector").hidden, "Ordinary tree selection reopened a hidden panel");
  await click('.tree-row[data-tree-id="0/0/0"]'); assert(element(".floating-inspector").hidden, "Returning to the previously diagnosed node replayed an old reveal request");
  await openReport(); checks.push({ scenario: "reveal after close, repeated node", result: await viewNode("本地设置标题", "0/0/0") });
  await input(".inspector-search input", "no-matching-property"); await click(".inspector-collapse");
  await until(() => element(".inspector-body").hidden === true, "Collapse did not hide body");
  await openReport(); checks.push({ scenario: "reveal collapsed panel, clear stale filter", result: await viewNode("本地播放设置", "0/1") });
  if (document.querySelector(".inspector-detach")) await click(".inspector-detach");
  element(".inspector-body").scrollTop = 1000;
  act(() => { element(".inspector-drag-handle").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true })); });
  await openReport(); checks.push({ scenario: "reveal moved/scrolled panel", result: await viewNode("本地设置标题", "0/0/0") });
  return { checks, calls: await readAudit(), fixtureOnly: true };
}
