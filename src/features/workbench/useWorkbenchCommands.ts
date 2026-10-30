import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AppMenuAction } from "../../../shared/types";
import { dispatchWorkbenchAction, dispatchWorkbenchShortcut, type WorkbenchDispatchContext } from "./workbench-dispatch";

type MenuPort = Pick<Window["electronApi"], "runtime" | "updateAppMenu" | "onAppMenuAction">;

export function useWorkbenchCommands({ api, ...context }: WorkbenchDispatchContext & { api: MenuPort }) {
  const current = useRef(context);
  useLayoutEffect(() => { current.current = context; });
  const [nativeMenu, setNativeMenu] = useState(false);
  const dispatch = useCallback((action: AppMenuAction) => { dispatchWorkbenchAction(action, current.current); }, []);
  useEffect(() => {
    if (!api.runtime.nativeMenu || !api.updateAppMenu) return;
    let active = true;
    void api.updateAppMenu(context.state).then(() => { if (active) setNativeMenu(true); }, () => { if (active) setNativeMenu(false); });
    return () => { active = false; };
  }, [api, context.state]);
  useEffect(() => api.onAppMenuAction?.(dispatch), [api, dispatch]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => dispatchWorkbenchShortcut(event, {
      nativeMenu, modalOpen: Boolean(document.querySelector("dialog[open]")), dispatch,
    });
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [dispatch, nativeMenu]);
  return { dispatch, nativeMenu };
}
