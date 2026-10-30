// Shared DOM assertions. App, React and styles come from the source or candidate renderer.
import { workbenchCommands, type WorkbenchCommand } from "../shared/workbench-commands";

type Act = (action: () => void) => void;
const direct: Act = action => action();
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`Workbench entry: ${message}`); }
function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector); assert(value, `missing ${selector}`); return value;
}
async function settle() { for (let i = 0; i < 5; i++) await tick(); }
async function until(condition: () => boolean) {
  const end = performance.now() + 4000;
  while (!condition()) { assert(performance.now() < end, "UI did not settle"); await tick(); }
  await settle();
}
async function click(selector: string, act: Act = direct) { const control = element(selector); act(() => { control.focus(); control.click(); }); await settle(); }
function reachable(control: HTMLElement) {
  const rect = control.getBoundingClientRect();
  assert(rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth + 1
    && rect.top >= 0 && rect.bottom <= innerHeight + 1, `control outside viewport: ${control.textContent}`);
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  assert(hit && control.contains(hit), `covered control: ${control.textContent}`);
}
function luminance(rgb: string) {
  const values = rgb.match(/[\d.]+/g)?.slice(0, 3).map(value => {
    const channel = Number(value) / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  assert(values?.length === 3, `unsupported color ${rgb}`);
  return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
}
function contrast(node: HTMLElement, surface: HTMLElement) {
  const a = luminance(getComputedStyle(node).color), b = luminance(getComputedStyle(surface).backgroundColor);
  const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05); assert(ratio >= 4.5, `low text contrast: ${ratio}`); return ratio;
}

export async function openHomeCommand(command: string, act: Act = direct) {
  if (!element<HTMLDetailsElement>(".home-application-menu").open) await click(".home-application-menu > summary", act);
  await click(`.home-application-menu [data-command="${command}"]`, act);
}

export async function verifyHomeDrawers() {
  if (document.querySelector(".home-history")) await click(".home-history .entry-dialog-close");
  assert(!document.querySelector(".debug-home-controls"), "home still shows the secondary toolbar");
  await click(".home-application-menu > summary");
  const menu = element(".home-application-menu-body"); reachable(menu);
  assert(menu.scrollWidth <= menu.clientWidth + 1, "application menu overflows horizontally");
  for (const control of menu.querySelectorAll<HTMLButtonElement>("button")) reachable(control);
  await click('.home-application-menu [data-command="history"]');
  const history = element<HTMLDialogElement>(".home-history"); reachable(history);
  assert(history.open && history.contains(document.activeElement), "history did not contain focus");
  assert(!element<HTMLDetailsElement>(".home-application-menu").open, "application menu stayed open behind history");
  assert(history.scrollWidth <= history.clientWidth + 1, "history overflows horizontally");
  const ratios = [contrast(element("#home-history-title"), history)];
  const row = document.querySelector<HTMLElement>(".home-history .snapshot-history-item");
  if (row) { reachable(row); ratios.push(contrast(row, element(".home-history .snapshot-history"))); }
  await click(".home-history .entry-dialog-close");
  assert(document.activeElement === element(".home-application-menu > summary"), "history lost menu focus");
  return { minimumContrast: Math.min(...ratios), noSecondaryToolbar: true, noHorizontalOverflow: true, controlsReachable: true };
}

export async function verifyHomeState(state: string, longDeviceName = false, act: Act = direct) {
  await until(() => document.querySelector<HTMLElement>(".home-view")?.dataset.state === state);
  const home = element(".home-view"), title = element(".home-center-state h2");
  const labels: Record<string, string> = { loading: "正在检查设备", unauthorized: "等待设备授权", offline: "设备已离线",
    "adb-missing": "ADB 尚未准备好", "no-device": "等待 Android 设备", error: "连接出现问题" };
  assert(home.scrollWidth <= home.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth, `home overflows horizontally in ${state}`);
  assert(!document.querySelector(".topbar-search, #global-node-search, .topbar .capture-button"), "duplicate hidden workbench actions on home");
  if (state === "connected") {
    assert(title.title === title.textContent && (!longDeviceName || title.title.length > 100), "full device name was lost");
    assert(document.querySelectorAll(".capture-button").length === 1, "duplicate home capture controls");
  } else assert(title.textContent === labels[state] && !document.querySelector(".capture-button"), "wrong state explanation or capture control");
  for (const control of document.querySelectorAll<HTMLElement>(".home-actions button")) {
    const rect = control.getBoundingClientRect();
    assert(rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth + 1, "home command leaves the viewport");
  }
  if (state === "loading") assert(element<HTMLButtonElement>(".home-primary-action").disabled && home.getAttribute("aria-busy") === "true", "loading still permits refresh");
  if (state === "error") {
    assert(element<HTMLButtonElement>(".home-secondary-action").disabled, "failed probe retained device switching");
    await click(".home-connection-detail > summary", act);
    const reason = element(".home-connection-detail p");
    assert(reason.textContent!.includes("本地连接错误") && reason.scrollWidth <= reason.clientWidth + 1, "connection reason was lost or overflows");
    await click(".home-connection-detail > summary", act);
  }
  return { state, title: title.textContent, noHorizontalOverflow: true };
}

export async function verifyDeviceChooser(disabled: boolean[], close: "button" | "cancel" = "button", act: Act = direct) {
  const trigger = element(".home-secondary-action[aria-haspopup=dialog]");
  await click(".home-secondary-action[aria-haspopup=dialog]", act);
  const chooser = element<HTMLDialogElement>(".home-device-switcher");
  assert(chooser.open && chooser.contains(document.activeElement), "device dialog did not contain focus");
  const options = [...chooser.querySelectorAll<HTMLButtonElement>(".home-device-option")];
  assert(options.length === disabled.length && options.every((option, index) => option.disabled === disabled[index]), "unavailable devices are selectable");
  assert(chooser.scrollWidth <= chooser.clientWidth + 1, "long device name overflows chooser");
  if (close === "cancel") { act(() => { chooser.dispatchEvent(new Event("cancel", { cancelable: true })); }); await settle(); }
  else await click(".home-device-switcher-close", act);
  assert(!document.querySelector(".home-device-switcher") && document.activeElement === trigger, "device dialog lost trigger focus");
}

export async function verifyHomePreferences(act: Act = direct, whileOpen: () => void = () => {}) {
  await openHomeCommand("preferences", act);
  const panel = element<HTMLDialogElement>(".preferences-panel"), preference = element<HTMLSelectElement>(".preferences-field select");
  assert(panel.open && panel.contains(document.activeElement), "preferences is not modal");
  act(() => { preference.value = "focus-branch"; preference.dispatchEvent(new Event("change", { bubbles: true })); }); await settle();
  assert(localStorage.getItem("android-ui-inspector.double-click") === "focus-branch", "preference did not persist");
  whileOpen(); await click(".entry-dialog-close", act);
  assert(document.activeElement === document.querySelector(".home-application-menu > summary"), "preference lost home focus");
}

export function verifyWorkbenchCommands() {
  const header = element(".inspection-header").getBoundingClientRect();
  const commands = [...document.querySelectorAll<HTMLButtonElement>(".workbench-utilities-body > [data-command], .workbench-export-actions > [data-command]")]
    .filter(button => !["debug-task-template", "connection-diagnosis", "live-preview"].includes(button.dataset.command!));
  const expected = ["test-report", "preferences", "open-snapshot", "save", "export-snapshot", "export-json", "export-xml", "export-png"];
  assert(commands.length === expected.length && commands.every((button, index) => button.dataset.command === expected[index] && !button.disabled), "command sources or entry count differs");
  for (const control of commands) {
    reachable(control);
    assert(control.getBoundingClientRect().top >= header.bottom && control.textContent === workbenchCommands[control.dataset.command as WorkbenchCommand].label, "command row overlaps the header or label differs from menu");
  }
  for (const [command, label] of [["debug-task-template", "任务模板"], ["connection-diagnosis", "连接诊断"], ["live-preview", "2D 实时预览"]]) {
    const control = element<HTMLButtonElement>(`.workbench-utilities [data-command="${command}"]`);
    reachable(control);
    assert(control.textContent === label, `observation entry differs: ${command}`);
  }
  return commands.length + 3;
}

export async function verifyEntryControls() {
  await verifyDeviceChooser([false, true, true]); await verifyHomePreferences();
  await click(".home-primary-action"); await until(() => Boolean(document.querySelector(".inspection-active .tree-row")));
  assert(element<HTMLSelectElement>(".tree-interaction-settings select").value === "focus-branch", "home preference differs from tree");
  await click(".workbench-utilities > summary"); const commands = verifyWorkbenchCommands();
  await click('[data-command="preferences"]');
  assert(element<HTMLSelectElement>(".preferences-field select").value === "focus-branch", "workbench preference differs");
  await click(".entry-dialog-close"); await click(".workbench-utilities > summary");
  await Promise.all(element(".capture-button").getAnimations().map(animation => animation.finished));
  return { scenarios: ["device modal disables unavailable devices and returns focus", "home/tree/workbench share persistent preference", "all actual menu commands are visible and reachable"], reachableCommands: commands };
}

export async function verifyOfflineHistory() {
  await until(() => document.querySelector<HTMLElement>(".home-view")?.dataset.state === "offline");
  const drawers = await verifyHomeDrawers();
  await openHomeCommand("history"); await click(".home-history .snapshot-history-item");
  await until(() => Boolean(document.querySelector(".inspection-active .tree-row")));
  assert(element<HTMLSelectElement>(".tree-interaction-settings select").value === "focus-branch", "saved preference was not retained after reload");
  assert(element<HTMLButtonElement>(".capture-button").disabled, "offline saved snapshot permits live capture");
  await click(".workbench-utilities > summary");
  assert(!element<HTMLButtonElement>('[data-command="export-json"]').disabled
    && element<HTMLButtonElement>('[data-command="export-xml"]').disabled
    && element<HTMLButtonElement>('[data-command="export-png"]').disabled, "missing export sources are enabled");
  return { drawers, scenarios: ["saved snapshots open offline without capture or writes", "persistent preference and actual export source availability"] };
}

export function verifyEmptyWorkbench() {
  assert(element(".workspace-empty-copy").textContent!.includes("准备采集"), "empty workbench has no explicit capture explanation");
  assert(!document.querySelector(".tree-row, .floating-inspector"), "empty capture fabricated content");
  for (const type of ["json", "xml", "png"]) assert(element<HTMLButtonElement>(`[data-command="export-${type}"]`).disabled, "empty capture enables an export without a source");
}
export function verifyCaptureFailure() {
  assert(!document.querySelector(".tree-row") && !element<HTMLButtonElement>(".capture-retry").disabled, "failed capture fabricated content or blocked retry");
}
export async function verifyEmptyCapture() {
  await until(() => document.querySelector<HTMLElement>(".home-view")?.dataset.state === "connected");
  await click(".home-primary-action"); await until(() => Boolean(document.querySelector(".inspector-empty-grid")));
  verifyEmptyWorkbench(); await click(".workbench-utilities > summary");
  return { scenarios: ["empty workbench keeps explicit capture and disabled exports"] };
}
export async function verifyFailedCapture() {
  await until(() => document.querySelector<HTMLElement>(".home-view")?.dataset.state === "connected");
  await click(".home-primary-action"); await until(() => Boolean(document.querySelector(".capture-failure-feedback")));
  verifyCaptureFailure();
  return { scenarios: ["failed workbench keeps explicit retry without automatic recapture"] };
}
