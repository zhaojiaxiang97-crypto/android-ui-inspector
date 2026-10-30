import { flushSync } from "react-dom";

/** Exercise the displayed zoom menu and restore its previous disclosure state. */
function withZoomMenu(host: ParentNode, action: (popup: HTMLElement) => void) {
  const toggle = host.querySelector<HTMLElement>(".zoom-continuous-toggle");
  if (!toggle) throw new Error("Missing zoom menu entry");
  const wasOpen = toggle.getAttribute("aria-expanded") === "true";
  if (!wasOpen) flushSync(() => toggle.click());
  const popup = document.querySelector<HTMLElement>("body > .zoom-continuous-popup");
  if (!popup) throw new Error("Zoom menu did not open");
  flushSync(() => action(popup));
  if (!wasOpen && toggle.getAttribute("aria-expanded") === "true") flushSync(() => toggle.click());
}
export function resetCanvasView(host: ParentNode) {
  withZoomMenu(host, popup => popup.querySelector<HTMLButtonElement>(".zoom-reset")!.click());
}
export function chooseCanvasZoom(host: ParentNode, value: number) {
  withZoomMenu(host, popup => {
    const select = popup.querySelector<HTMLSelectElement>(".zoom-preset-select")!;
    select.value = String(value); select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
