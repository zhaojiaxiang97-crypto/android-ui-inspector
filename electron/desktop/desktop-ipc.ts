export interface DesktopSender {
  id: number;
  mainFrame: unknown;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
}
export interface DesktopInvokeEvent { sender: DesktopSender; senderFrame: unknown }

/** Check both owning WebContents and its main frame before accepting desktop requests. */
export function requireDesktopOwner(event: DesktopInvokeEvent, current: DesktopSender | undefined, message: string) {
  if (event.sender !== current || event.senderFrame !== event.sender.mainFrame) throw new Error(message);
}
