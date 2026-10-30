export type ViewingScope = {
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
