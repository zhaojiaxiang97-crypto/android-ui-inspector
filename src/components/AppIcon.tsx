import type { CSSProperties } from "react";
import "../styles/app-icon.css";

export const iconNames = [
  "device", "refresh", "measure", "select-inside", "settings", "history", "sidebar",
  "copy", "camera", "stop", "chevron", "close", "plus", "minus",
  "drag", "popout", "compare", "search", "resize", "cursor", "type",
  "business", "link", "image", "document", "info", "help", "front",
  "stacked", "exploded", "arrow-up-right", "alert", "hierarchy", "more", "layout",
  "activity", "window", "linear", "pager", "list", "grid", "scroll",
  "text", "input", "button", "checkbox", "radio", "switch", "slider",
  "progress", "web", "video", "surface", "stub", "folder", "leaf",
] as const;
export type IconName = typeof iconNames[number];

const assets = import.meta.glob<string>("../assets/icons/*.png", { eager: true, query: "?url", import: "default" });

/** Generated artwork supplies the alpha; the surrounding control supplies its color and accessible name. */
export function AppIcon({ name, size = 16, rotate = 0, className = "", title }: {
  name: IconName; size?: number; rotate?: number; className?: string; title?: string;
}) {
  const image = assets[`../assets/icons/${name}.png`];
  return <span aria-hidden="true" data-icon={name} className={`ui-icon ${className}`.trim()} title={title}
    style={{ "--ui-icon-image": `url("${image}")`, "--ui-icon-size": `${size}px`, "--ui-icon-rotation": `${rotate}deg` } as CSSProperties} />;
}
