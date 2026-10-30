import type { ManuallyHiddenLayer } from "../../../shared/tree-hidden-state";
import type { UiNode } from "../../../shared/types";

export type ViewingScope = {
  hiddenLayers?: readonly ManuallyHiddenLayer[];
  hiddenListScope?: object | string | number;
  locateHiddenLayer?: (node: UiNode) => boolean;
  restoreHiddenLayer?: (node: UiNode) => boolean;
  selectedHiddenAncestorLabel?: string | null;
  locateHiddenAncestor?: () => boolean;
  focusLabel: string | null;
  focusKind: "layer" | "branch" | null;
  query: string;
  interactiveOnly: boolean;
  identifiedOnly: boolean;
  hiddenCount: number;
  disabledReason: string | null;
  clearQuery: () => boolean;
  clearInteractive: () => boolean;
  clearIdentified: () => boolean;
  exitFocus: () => boolean;
  restoreHidden: () => boolean;
  restoreAll: () => boolean;
};
