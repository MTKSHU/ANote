import { t as translateUI } from "@anote/i18n";
import React, { useLayoutEffect, useRef } from "react";
import { Icon } from "./icons";

type Layer = { element: HTMLElement; restore: HTMLElement | null };
const layers: Layer[] = [];
const focusable = 'a[href],button:not(:disabled),input:not(:disabled):not([type="hidden"]),textarea:not(:disabled),select:not(:disabled),summary,[tabindex]:not([tabindex="-1"]),iframe';
const visible = (element: HTMLElement) => element.isConnected && element.getClientRects().length > 0 && !element.closest('[inert],[hidden]') && getComputedStyle(element).visibility !== "hidden";
const items = (element: HTMLElement) => [...element.querySelectorAll<HTMLElement>(focusable)].filter(visible);
const focusTrail: HTMLElement[] = [];
let interaction: {element:HTMLElement;at:number}|null = null;
if (typeof document !== "undefined") {
  document.addEventListener("focusin", event => {
    if (!(event.target instanceof HTMLElement)) return;
    focusTrail.push(event.target);
    if (focusTrail.length > 32) focusTrail.shift();
  });
  const remember=(event:Event)=>{
    const target=event.target instanceof Element ? event.target.closest<HTMLElement>(focusable) : null;
    if(target)interaction={element:target,at:performance.now()};
  };
  document.addEventListener("pointerdown",remember,true);
  document.addEventListener("keydown",remember,true);
}

/** One keyboard/focus policy for blocking dialogs; editor popovers stay non-modal. */
export function useDialog<T extends HTMLElement = HTMLElement>(onClose: (() => void) | null, options: { disabled?: boolean; open?: boolean } = {}) {
  const ref = useRef<T>(null);
  const current = useRef({ onClose, disabled: options.disabled });
  current.current = { onClose, disabled: options.disabled };
  useLayoutEffect(() => {
    if (options.open === false || !ref.current) return;
    const element = ref.current;
    // React input autofocus can run before the parent's layout effect. Keep the
    // actual trigger rather than treating that new input as the return target.
    const active=document.activeElement as HTMLElement|null;
    const recent=interaction && performance.now()-interaction.at<500 ? interaction.element : null;
    const previous = active && active!==document.body && !element.contains(active) ? active
      : recent && !element.contains(recent) && recent.isConnected ? recent
      : [...focusTrail].reverse().find(target=>!element.contains(target) && visible(target)) || null;
    const fallback = previous?.closest("details")?.querySelector<HTMLElement>("summary") || null;
    const layer = { element, restore: previous };
    layers.push(layer);
    const overlay = element.matches(".modal") ? element : element.closest<HTMLElement>(".modal");
    const oldZIndex = overlay?.style.zIndex || "";
    if (overlay) overlay.style.zIndex = String(3000 + layers.length * 10);
    element.setAttribute("aria-modal", "true");
    if (!element.hasAttribute("tabindex")) element.tabIndex = -1;
    const top = () => layers[layers.length - 1] === layer;
    const focusFirst = () => {
      const target = element.querySelector<HTMLElement>('[autofocus],[data-dialog-initial-focus]');
      (target && visible(target) ? target : items(element)[0] || element).focus({ preventScroll: true });
    };
    // Preserve existing autofocus and the caret in an input on initial mount.
    if (!element.contains(document.activeElement)) focusFirst();
    const keydown = (event: KeyboardEvent) => {
      if (!top() || event.defaultPrevented || event.isComposing) return;
      if (event.key === "Escape" && current.current.onClose) {
        event.preventDefault(); event.stopPropagation();
        if (!current.current.disabled) current.current.onClose();
      }
      if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const targets = items(element), first = targets[0], last = targets.at(-1);
        if (!first) { event.preventDefault(); element.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) { event.preventDefault(); last!.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === element)) { event.preventDefault(); first.focus(); }
      }
    };
    const focusin = (event: FocusEvent) => {
      if (top() && !element.contains(event.target as Node)) focusFirst();
    };
    document.addEventListener("keydown", keydown);
    document.addEventListener("focusin", focusin);
    return () => {
      const wasTop = top();
      const index = layers.indexOf(layer); if (index >= 0) layers.splice(index, 1);
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("focusin", focusin);
      if (overlay) overlay.style.zIndex = oldZIndex;
      if (wasTop) {
        const target = previous && visible(previous) ? previous : fallback && visible(fallback) ? fallback : layers.at(-1)?.element;
        target?.focus({ preventScroll: true });
      }
    };
  }, [options.open]);
  return ref;
}

export function DialogClose({ onClick, label = translateUI("关闭"), disabled = false }: { onClick: () => void; label?: string; disabled?: boolean }) {
  return <button type="button" className="dialog-close" aria-label={label} title={`${label}（Esc）`} onClick={onClick} disabled={disabled}><Icon name="close" size={18}/></button>;
}
