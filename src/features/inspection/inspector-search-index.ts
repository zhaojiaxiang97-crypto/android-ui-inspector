import { INSPECTOR_GROUPS, type InspectorGroupId } from "../../../shared/inspector-groups";
import type { InspectorSearchProperty } from "../../../shared/inspector-search";

export type IndexedInspectorProperty = InspectorSearchProperty & { element: HTMLElement };

function plainText(element: Element) {
  const copy = element.cloneNode(true) as Element;
  // Buttons and decorative text never become searchable attribute values.
  copy.querySelectorAll("button, svg, [aria-hidden=true], .inspector-color-actions").forEach(child => child.remove());
  return copy.textContent?.trim() ?? "";
}

/** Read the rendered rows, including folded/hidden groups. No duplicate property schema or device requests. */
export function indexInspectorProperties(panel: HTMLElement): IndexedInspectorProperty[] {
  const properties: IndexedInspectorProperty[] = [];
  panel.querySelectorAll("[data-inspector-property]").forEach(element => element.removeAttribute("data-inspector-property"));
  for (const { id: group, label: groupLabel } of INSPECTOR_GROUPS) {
    const card = panel.querySelector<HTMLElement>(`.inspector-${group === "raw" ? "more" : group}`);
    if (!card) continue;
    const add = (element: HTMLElement, label: string, fallback: string, extra: string[] = []) => {
      const value = element.dataset.inspectorValue ?? fallback;
      const ancestors: string[] = [];
      for (let parent = element.parentElement; parent && parent !== card; parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement) {
          const summary = parent.querySelector(":scope > summary");
          if (summary) ancestors.unshift(plainText(summary));
        }
      }
      const section = [groupLabel, ...ancestors].join(" · ");
      const id = `property-${properties.length}`;
      element.dataset.inspectorProperty = id;
      properties.push({ id, group: group as InspectorGroupId, section, label, value, element,
        terms: [section, fallback, ...extra, element.dataset.inspectorTerms ?? "", value === "" ? "空字符串 empty ∅" : ""] });
    };
    // Overview rows retain their original group without duplicating the full detail fields.
    const containers = [...panel.querySelectorAll<HTMLElement>(`[data-inspector-group="${group}"]`), card];
    // Select only real dt/dd rows; nested colour content has no direct dt and is skipped.
    containers.forEach(container => container.querySelectorAll<HTMLElement>("dl > div").forEach(row => {
      const name = row.querySelector(":scope > dt"), value = row.querySelector(":scope > dd");
      if (!name || !value) return;
      const labelCopy = name.cloneNode(true) as Element;
      labelCopy.querySelectorAll("small, button, svg").forEach(element => element.remove());
      const original = value.getAttribute("title") ?? plainText(value);
      add(row, labelCopy.textContent?.trim() ?? "", original, [name.getAttribute("title") ?? "", plainText(value)]);
    }));
    card.querySelectorAll<HTMLElement>("[data-inspector-label]").forEach(element => {
      if (element.dataset.inspectorProperty) return;
      add(element, element.dataset.inspectorLabel!, plainText(element));
    });
    if (group === "raw") card.querySelectorAll<HTMLElement>(".selector-row").forEach((row, index) => {
      const code = row.querySelector("code");
      if (code) add(row, ["XPath", "UiSelector", "ADB 点击命令"][index] ?? "定位器", code.getAttribute("title") ?? plainText(code));
    });
  }
  return properties;
}
