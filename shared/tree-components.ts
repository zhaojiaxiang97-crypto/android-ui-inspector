import { androidViewClasses } from "./tree-utils";
import type { UiNode } from "./types";

const COLLECTION_CLASSES = new Set([
  "androidx.recyclerview.widget.RecyclerView", "android.support.v7.widget.RecyclerView",
  "android.widget.ListView", "android.widget.GridView", "android.widget.ExpandableListView", "android.widget.AbsListView",
]);
const CARD_CLASSES = new Set([
  "androidx.cardview.widget.CardView", "android.support.v7.widget.CardView", "com.google.android.material.card.MaterialCardView",
]);
const BAR_CLASSES = new Set([
  "android.widget.Toolbar", "androidx.appcompat.widget.Toolbar", "android.support.v7.widget.Toolbar",
  "com.google.android.material.tabs.TabLayout", "android.support.design.widget.TabLayout",
  "com.google.android.material.bottomnavigation.BottomNavigationView", "android.support.design.widget.BottomNavigationView",
  "com.google.android.material.navigation.NavigationView", "android.support.design.widget.NavigationView",
  "com.google.android.material.navigationrail.NavigationRailView",
]);

// Exact framework types or a validated SDK inheritance chain. A custom name
// ending in RecyclerView is not enough to collapse an unknown container.
export function componentBoundaryIds(root: UiNode): ReadonlySet<string> {
  const boundaries = new Set<string>(), stack = [{ node: root, collectionItem: false }];
  while (stack.length) {
    const { node, collectionItem } = stack.pop()!;
    const classes = androidViewClasses(node);
    if (node.children.length && (collectionItem || classes.some(name => CARD_CLASSES.has(name) || BAR_CLASSES.has(name)))) boundaries.add(node.id);
    const collection = classes.some(name => COLLECTION_CLASSES.has(name));
    for (const child of node.children) stack.push({ node: child, collectionItem: collection });
  }
  return boundaries;
}
