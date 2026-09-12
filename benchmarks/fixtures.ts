import type { UiNode } from "../shared/types";

export type TreeShape = "balanced" | "wide";

export function makeNode(id: string, sequence = 0): UiNode {
  return {
    id,
    index: sequence,
    className: sequence % 4 === 0 ? "android.view.ViewGroup" : "android.widget.TextView",
    package: "com.example.benchmark",
    text: sequence % 97 === 0 ? `synthetic-target ${sequence}` : sequence % 7 === 0 ? null : `Node ${sequence}`,
    resourceId: sequence % 5 === 0 ? `com.example.benchmark:id/item_${sequence}` : null,
    contentDesc: sequence % 13 === 0 ? `Description ${sequence}` : null,
    bounds: { left: 0, top: sequence % 100 * 10, right: 360, bottom: sequence % 100 * 10 + 48, raw: `[0,${sequence % 100 * 10}][360,${sequence % 100 * 10 + 48}]` },
    clickable: sequence % 3 === 0,
    enabled: true,
    focusable: sequence % 11 === 0,
    focused: false,
    scrollable: sequence % 17 === 0,
    selected: false,
    visibleToUser: true,
    children: [],
  };
}

// Breadth-first construction always produces exactly the requested size.
export function createTree(size: number, shape: TreeShape = "balanced"): UiNode {
  if (!Number.isInteger(size) || size < 1) throw new Error("Tree size must be a positive integer");
  const root = makeNode("0");
  const nodes = [root];
  const width = shape === "balanced" ? 4 : Math.max(1, size - 1);
  for (let index = 1; index < size; index += 1) {
    const parent = nodes[Math.floor((index - 1) / width)];
    const node = makeNode(`${parent.id}/${parent.children.length}`, index);
    node.index = parent.children.length;
    parent.children.push(node);
    nodes.push(node);
  }
  return root;
}
