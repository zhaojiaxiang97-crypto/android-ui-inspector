import { AppIcon } from "./AppIcon";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { nodeDisplayLabel } from "../../shared/tree-utils";
import type { ManuallyHiddenLayer } from "../../shared/tree-hidden-state";
import type { ViewingScope } from "../features/inspection/viewing-scope";
import "../styles/hidden-layers-list.css";

const PAGE_SIZE = 30;
type Source = NonNullable<ViewingScope["hiddenListScope"]>;

export function HiddenLayersList({ scope }: { scope: ViewingScope }) {
  const id = useId(), opener = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null), heading = useRef<HTMLHeadingElement>(null), composing = useRef(false);
  const current = useRef(scope); current.current = scope;
  const [reading, setReading] = useState<{ source: Source; page: number } | null>(null);
  const [position, setPosition] = useState({ left: 8, top: 8, width: 248, maxHeight: 400 });
  const pendingFocus = useRef<number | null>(null);
  const items = scope.hiddenLayers ?? [], total = items.length;
  const open = Boolean(reading && reading.source === scope.hiddenListScope && scope.hiddenLayers && !scope.disabledReason);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE)), page = Math.min(reading?.page ?? 0, pages - 1);
  const visible = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  function close(restoreFocus = false) {
    setReading(null); pendingFocus.current = null; composing.current = false;
    if (restoreFocus && opener.current?.isConnected && !opener.current.disabled) {
      const target = current.current.hiddenLayers?.length ? opener.current : opener.current.closest(".ui-tree")?.querySelector<HTMLElement>('[role="tree"]');
      target?.focus({ preventScroll: true });
    }
  }
  function sourceCurrent() {
    return open && reading?.source === current.current.hiddenListScope && !current.current.disabledReason;
  }
  function act(item: ManuallyHiddenLayer, action: "locate" | "restore", position: number) {
    const latest = current.current;
    if (!sourceCurrent() || !latest.hiddenLayers?.some(entry => entry.node === item.node)) return;
    if (action === "locate") {
      if (latest.locateHiddenLayer?.(item.node)) close(true);
    } else {
      pendingFocus.current = position;
      if (!latest.restoreHiddenLayer?.(item.node)) pendingFocus.current = null;
    }
  }
  useLayoutEffect(() => {
    if (!open) { if (reading) setReading(null); return; }
    const place = () => {
      const anchor = (opener.current?.closest(".tree-viewing-scope") ?? opener.current)?.getBoundingClientRect(), element = popup.current;
      if (!anchor || !element) return;
      const pane = opener.current?.closest(".tree-pane")?.getBoundingClientRect();
      const width = Math.max(0, Math.min(pane?.width ?? 306, innerWidth - 16));
      const left = Math.max(8, Math.min(pane?.left ?? anchor.left, innerWidth - width - 8));
      const below = innerHeight - anchor.bottom - 12, above = anchor.top - 12;
      const maxHeight = Math.min(480, Math.max(below, above, 0));
      const height = Math.min(element.scrollHeight, maxHeight);
      const top = below >= Math.min(240, maxHeight) ? anchor.bottom + 4 : Math.max(8, anchor.top - height - 4);
      setPosition({ left, top, width, maxHeight: Math.max(0, Math.min(maxHeight, innerHeight - top - 8)) });
    };
    place(); heading.current?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    list.current?.scrollTo({ top: 0 });
  }, [open, page]);
  useLayoutEffect(() => {
    if (!open) return;
    if (reading && reading.page !== page) setReading({ ...reading, page });
    if (pendingFocus.current !== null) {
      const buttons = list.current?.querySelectorAll<HTMLButtonElement>(".hidden-layer-restore");
      const next = buttons?.[Math.min(pendingFocus.current, buttons.length - 1)];
      (next ?? heading.current)?.focus({ preventScroll: true });
      pendingFocus.current = null;
    } else if (document.activeElement instanceof HTMLButtonElement && document.activeElement.disabled
      && popup.current?.contains(document.activeElement)) heading.current?.focus({ preventScroll: true });
  }, [open, page, items]);
  useLayoutEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !opener.current?.contains(event.target) && !popup.current?.contains(event.target)) close();
    };
    const blur = () => close();
    window.addEventListener("pointerdown", outside, true); window.addEventListener("focusin", outside);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointerdown", outside, true); window.removeEventListener("focusin", outside); window.removeEventListener("blur", blur);
    };
  }, [open]);
  if (!scope.hiddenLayers || scope.hiddenListScope === undefined || (!total && !open)) return null;
  return <>
    <button ref={opener} type="button" className="tree-scope-restore hidden-layers-toggle" disabled={Boolean(scope.disabledReason)}
      aria-label="查看隐藏项" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      title={scope.disabledReason ?? "查看手动隐藏的控件，逐项定位或恢复"} onClick={() => {
        if (open) close(true);
        else if (scope.hiddenListScope !== undefined && !scope.disabledReason) setReading({ source: scope.hiddenListScope, page: 0 });
      }}>查看隐藏项</button>
    {open && createPortal(<div ref={popup} id={id} className="hidden-layers-popup" role="dialog" aria-modal="false" aria-labelledby={`${id}-title`} style={position}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
      }}>
      <header><h3 ref={heading} id={`${id}-title`} tabIndex={-1}>手动隐藏 <span>{total} 层</span></h3>
        <button type="button" className="hidden-layers-close" aria-label="关闭隐藏项清单" title="关闭 · Esc" onClick={() => close(true)}><AppIcon name="close" size={14} /></button></header>
      <p className="hidden-layers-hint">只列工具内手动隐藏；设备不可见与缺图保持原状态。</p>
      {total > 0 ? <ul ref={list} className="hidden-layers-items" aria-label="手动隐藏的控件">
        {visible.map((item, position) => <li key={item.node.id} className="hidden-layer-item" data-node-id={item.node.id}>
          <strong className="hidden-layer-name">{nodeDisplayLabel(item.node)}</strong>
          {item.node.resourceId && <div className="hidden-layer-detail"><span>资源 ID</span><code>{item.node.resourceId}</code></div>}
          <div className="hidden-layer-detail"><span>节点 ID</span><code>{item.node.id}</code></div>
          <details className="hidden-layer-path"><summary>层级路径</summary><p>{item.path}</p></details>
          {item.hiddenAncestor && <p className="hidden-layer-ancestor">恢复本层后仍被父层隐藏：{nodeDisplayLabel(item.hiddenAncestor)}</p>}
          <div className="hidden-layer-actions">
            <button type="button" className="hidden-layer-locate" disabled={!scope.locateHiddenLayer}
              aria-label={`定位隐藏项：${nodeDisplayLabel(item.node)}`} onClick={() => act(item, "locate", position)}>定位</button>
            <button type="button" className="hidden-layer-restore" disabled={!scope.restoreHiddenLayer}
              aria-label={`恢复隐藏项：${nodeDisplayLabel(item.node)}`} onClick={() => act(item, "restore", position)}>恢复本层</button>
          </div>
        </li>)}
      </ul> : <p className="hidden-layers-empty" role="status">没有手动隐藏的控件</p>}
      <footer>
        <div className="hidden-layers-pagination" role="group" aria-label="隐藏项分页">
          <span role="status" aria-live="polite">{total ? `第 ${page * PAGE_SIZE + 1}–${Math.min(total, (page + 1) * PAGE_SIZE)} 项，共 ${total} 项` : "共 0 项"}</span>
          <div><button type="button" className="hidden-layers-previous" aria-label="上一页隐藏项" disabled={page === 0}
            onClick={() => { if (sourceCurrent()) setReading({ source: reading!.source, page: page - 1 }); }}>上一页</button>
            <button type="button" className="hidden-layers-next" aria-label="下一页隐藏项" disabled={page === pages - 1}
              onClick={() => { if (sourceCurrent()) setReading({ source: reading!.source, page: page + 1 }); }}>下一页</button></div>
        </div>
        <button type="button" className="hidden-layers-restore-all" disabled={!total}
          onClick={() => { if (sourceCurrent()) current.current.restoreHidden(); }}>恢复全部手动隐藏</button>
      </footer>
    </div>, document.body)}
  </>;
}
