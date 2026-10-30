import { useLayoutEffect, useRef, type ReactNode } from "react";

export function EntryDialog({ className, labelledBy, onClose, children, open = true }: {
  className: string; labelledBy: string; onClose: () => void; children: ReactNode; open?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      if (previous?.isConnected && previous.getClientRects().length) previous.focus({ preventScroll: true });
    };
  }, [open]);
  return <dialog ref={dialog} className={`entry-dialog ${className}`} aria-labelledby={labelledBy}
    onKeyDown={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); onClose(); }}>
    {children}
  </dialog>;
}
