import type { UiNode } from "../../../shared/types";


function xpathLiteral(value: string) {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;

  const parts = value.split("'");
  const expressions: string[] = [];
  parts.forEach((part, index) => {
    if (part) expressions.push(`'${part}'`);
    if (index < parts.length - 1) expressions.push(`"'"`);
  });
  return `concat(${expressions.join(",")})`;
}

export function findNodePath(root: UiNode, targetId: string) {
  const path: UiNode[] = [];

  function visit(node: UiNode): boolean {
    path.push(node);
    if (node.id === targetId) return true;

    for (const child of node.children) {
      if (visit(child)) return true;
    }

    path.pop();
    return false;
  }

  return visit(root) ? path : null;
}

export function xpathForNode(root: UiNode, node: UiNode) {
  const className = node.className ?? "*";
  if (node.resourceId) return `//${className}[@resource-id=${xpathLiteral(node.resourceId)}]`;
  if (node.contentDesc) return `//${className}[@content-desc=${xpathLiteral(node.contentDesc)}]`;
  if (node.text) return `//${className}[@text=${xpathLiteral(node.text)}]`;

  const path = findNodePath(root, node.id);
  if (!path) return `//${className}`;

  return `//${path.map((item, index) => {
    const itemClass = item.className ?? "*";
    if (index === 0) return itemClass;
    const rawIndex = Number.parseInt(item.id.split("/").pop() ?? "", 10);
    return `${itemClass}[${Number.isFinite(rawIndex) ? rawIndex + 1 : 1}]`;
  }).join("/")}`;
}

export function uiSelectorForNode(node: UiNode) {
  const parts = ["new UiSelector()"];
  if (node.className) parts.push(`.className(${JSON.stringify(node.className)})`);
  if (node.resourceId) {
    parts.push(`.resourceId(${JSON.stringify(node.resourceId)})`);
  } else if (node.text) {
    parts.push(`.text(${JSON.stringify(node.text)})`);
  } else if (node.contentDesc) {
    parts.push(`.description(${JSON.stringify(node.contentDesc)})`);
  }
  if (node.index !== null) parts.push(`.index(${node.index})`);
  return parts.join("");
}

export function adbTapCommand(serial: string, node: UiNode) {
  if (!node.bounds) return "当前节点没有有效 bounds";
  const x = Math.round((node.bounds.left + node.bounds.right) / 2);
  const y = Math.round((node.bounds.top + node.bounds.bottom) / 2);
  return `adb -s ${JSON.stringify(serial)} shell input tap ${x} ${y}`;
}

export function nodeJson(node: UiNode) {
  return JSON.stringify(node, null, 2);
}
