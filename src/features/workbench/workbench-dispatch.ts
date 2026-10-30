import type { AppMenuAction, AppMenuState } from "../../../shared/types";
import { commandEnabled, commandForShortcut, type WorkbenchCommand } from "../../../shared/workbench-commands";

export type WorkbenchHandlers = Record<WorkbenchCommand, () => void>;
export type WorkbenchDispatchContext = {
  state: AppMenuState;
  debugActive: boolean;
  debugStarting: boolean;
  handlers: WorkbenchHandlers;
  onDevice: (serial: string) => void;
  onDoubleClick: (action: Extract<AppMenuAction, { type: "double-click" }>["action"]) => void;
};

// All entry points use the same availability rule before invoking the use case.
export function dispatchWorkbenchAction(action: AppMenuAction, context: WorkbenchDispatchContext): boolean {
  if (action.type === "device") {
    if (!context.state.canSelectDevice || action.serial !== "" && !context.state.devices.some(device => device.serial === action.serial && device.state === "device")) return false;
    context.onDevice(action.serial); return true;
  }
  if (action.type === "double-click") { context.onDoubleClick(action.action); return true; }
  if (!commandEnabled(action.type, context.state, context.debugActive, context.debugStarting)) return false;
  context.handlers[action.type]();
  return true;
}

export function dispatchWorkbenchShortcut(event: KeyboardEvent, options: {
  nativeMenu: boolean; modalOpen: boolean; dispatch: (action: AppMenuAction) => void;
}): void {
  // Composition belongs to the text field, even when the IME also emits a command modifier.
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
  const type = commandForShortcut(event);
  if (!type || options.nativeMenu) return;
  event.preventDefault();
  if (!event.repeat && !options.modalOpen) options.dispatch({ type });
}
