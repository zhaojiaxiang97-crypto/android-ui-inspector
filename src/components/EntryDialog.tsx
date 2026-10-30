import { useLayoutEffect, useRef, type ReactNode } from "react";

export function EntryDialog({ className, labelledBy, onClose, children }: {
  className: string; labelledBy: string; onClose: () => void; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      if (previous?.isConnected && previous.getClientRects().length) previous.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialog} className={`entry-dialog ${className}`} aria-labelledby={labelledBy}
    onKeyDown={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); onClose(); }}>
    {children}
  </dialog>;
}
