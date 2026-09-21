import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import BasicToast, { type ToastType } from "./basic-toast";

type Options = {
  type?: ToastType;
  duration?: number;
  id?: string;
  href?: string;
};
type Entry = {
  key: number;
  message: string;
  type: ToastType;
  duration: number;
  id?: string;
  href?: string;
  visible: boolean;
  element?: HTMLElement;
  source?: HTMLElement;
  sourceSignature?: string;
  close: () => void;
};
type Handle = { close: () => void };
type Queued = { message: string; options?: Options; cancelled?: boolean; handle?: Handle };
declare global {
  interface Window {
    StoreToast?: { show: (message: string, options?: Options) => Handle; dismiss: (id: string) => void };
    __storeToastQueue?: Queued[];
  }
}

const types = new Set(["success", "error", "info", "warning"]);
const entries: Entry[] = [];
const enhanced = new WeakMap<HTMLElement, string>();
const sourceEntries = new WeakMap<HTMLElement, Entry>();
let serial = 0;
let scheduledLayout = 0;
const container = document.createElement("div");
container.id = "store-toast-root";
document.body.append(container);
const root = createRoot(container);

function scheduleLayout() {
  if (scheduledLayout) return;
  scheduledLayout = requestAnimationFrame(() => {
    scheduledLayout = 0;
    let top = 0;
    for (const entry of entries) {
      if (!entry.element) continue;
      entry.element.style.setProperty("--store-toast-top", `calc(1rem + env(safe-area-inset-top, 0px) + ${top}px)`);
      // Transform исходной spring-анимации не меняет раскладку стека.
      top += entry.element.offsetHeight + 12;
    }
  });
}

function safeHref(href?: string): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href, location.href);
    return url.origin === location.origin && /^(https?:)$/.test(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

function signature(element: HTMLElement): string {
  return JSON.stringify([
    element.getAttribute("data-toast-message") ?? element.textContent?.trim() ?? "",
    element.dataset.toastType || inferredType(element), element.dataset.toastDuration,
    element.dataset.toastHref, element.dataset.toastId,
  ]);
}

function inferredType(element: HTMLElement): ToastType {
  if (element.classList.contains("err") || element.classList.contains("is-err")) return "error";
  if (element.classList.contains("ok")) return "success";
  return "info";
}

function ToastItem({ entry }: { entry: Entry }) {
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let observer: MutationObserver | undefined;
    let readyFrame = 0;
    function attach() {
      const element = document.querySelector<HTMLElement>(`.store-toast-${entry.key}`);
      if (!element) return false;
      observer?.disconnect();
      entry.element = element;
      element.dataset.toastType = entry.type;
      element.setAttribute("role", entry.type === "error" ? "alert" : "status");
      element.setAttribute("aria-live", entry.type === "error" ? "assertive" : "polite");
      element.setAttribute("aria-atomic", "true");
      element.querySelector("button")?.setAttribute("aria-label", "Закрыть уведомление");
      const click = (event: MouseEvent) => {
        if (!(event.target as Element).closest("button") && entry.href) location.assign(entry.href);
      };
      const keyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") { entry.close(); return; }
        if (entry.href && event.target === element && event.key === "Enter") {
          event.preventDefault();
          location.assign(entry.href);
        }
      };
      if (entry.href) {
        element.dataset.toastHref = entry.href;
        element.tabIndex = 0;
        element.setAttribute("aria-label", `${entry.message}. Нажмите Enter, чтобы открыть`);
      }
      element.addEventListener("click", click);
      element.addEventListener("keydown", keyDown);
      const resize = typeof ResizeObserver === "function" ? new ResizeObserver(scheduleLayout) : undefined;
      resize?.observe(element);
      scheduleLayout();
      readyFrame = requestAnimationFrame(() => {
        if (entry.source?.isConnected && signature(entry.source) === entry.sourceSignature) {
          // Исходное сообщение остаётся видимым, пока настоящий компонент не смонтирован.
          entry.source.dataset.storeToastEnhanced = "true";
        }
      });
      cleanup = () => {
        cancelAnimationFrame(readyFrame);
        resize?.disconnect();
        element.removeEventListener("click", click);
        element.removeEventListener("keydown", keyDown);
        entry.element = undefined;
      };
      return true;
    }
    if (!attach()) {
      observer = new MutationObserver(attach);
      observer.observe(document.body, { childList: true });
    }
    return () => { observer?.disconnect(); cleanup?.(); };
  }, [entry]);
  return <BasicToast
    className={`store-toast-card store-toast-${entry.key}`}
    message={entry.message}
    type={entry.type}
    duration={entry.duration}
    isVisible={entry.visible}
    onClose={entry.close}
  />;
}

function render() {
  root.render(<>{entries.slice(0, 4).map(entry => <ToastItem key={entry.key} entry={entry} />)}</>);
  scheduleLayout();
}

function remove(entry: Entry) {
  const index = entries.indexOf(entry);
  if (index !== -1) { entries.splice(index, 1); render(); }
}

function show(message: string, options: Options = {}, source?: HTMLElement): Handle {
  const text = String(message ?? "").trim();
  if (!text) return { close() {} };
  const type = types.has(options.type || "") ? options.type! : "info";
  const duration = Number.isFinite(options.duration) && options.duration! >= 0
    ? options.duration! : 3000;
  if (options.id) {
    const previous = entries.find(entry => entry.id === String(options.id));
    if (previous) entries.splice(entries.indexOf(previous), 1);
  }
  if (source) {
    const previous = sourceEntries.get(source);
    if (previous && entries.includes(previous)) entries.splice(entries.indexOf(previous), 1);
  }
  if (entries.length >= 4) {
    // Постоянная ошибка не должна исчезать из-за новых SSE-уведомлений.
    // Если все четыре требуют закрытия, следующий тост ждёт свободного места.
    const transient = entries.findIndex(entry => entry.duration > 0);
    if (transient !== -1) entries.splice(transient, 1);
  }
  const entry: Entry = {
    key: ++serial, message: text, type, duration,
    id: options.id ? String(options.id) : undefined,
    href: safeHref(options.href), visible: true, source,
    sourceSignature: source ? signature(source) : undefined,
    close() {
      if (!entry.visible) return;
      entry.visible = false;
      render();
      // Даём исходной exit-анимации (0,15 с) закончиться до размонтирования.
      window.setTimeout(() => remove(entry), 180);
    },
  };
  entries.push(entry);
  if (source) sourceEntries.set(source, entry);
  render();
  return { close: entry.close };
}

function enhance(element: HTMLElement) {
  const next = signature(element);
  const message = element.getAttribute("data-toast-message") ?? element.textContent?.trim() ?? "";
  // hidden принадлежит форме: движок скрывает fallback своим отдельным атрибутом.
  if (element.hidden || !message) {
    sourceEntries.get(element)?.close();
    enhanced.delete(element);
    delete element.dataset.storeToastEnhanced;
    return;
  }
  if (enhanced.get(element) === next) return;
  delete element.dataset.storeToastEnhanced;
  const duration = element.dataset.toastDuration;
  enhanced.set(element, next);
  show(message, {
    type: (element.dataset.toastType || inferredType(element)) as ToastType,
    duration: duration === undefined ? undefined : Number(duration),
    id: element.dataset.toastId,
    href: element.dataset.toastHref,
  }, element);
}

function scan(node: Node) {
  if (!(node instanceof Element)) return;
  if (node.matches("[data-store-toast]")) enhance(node as HTMLElement);
  node.querySelectorAll<HTMLElement>("[data-store-toast]").forEach(enhance);
}

window.StoreToast = { show, dismiss(id) { entries.filter(entry => entry.id === String(id)).forEach(entry => entry.close()); } };
document.addEventListener("store:toast", event => {
  const detail = (event as CustomEvent).detail;
  if (detail?.message != null) show(detail.message, detail.options || detail);
});
const pending = window.__storeToastQueue || [];
window.__storeToastQueue = [];
pending.forEach(item => { if (!item.cancelled) item.handle = show(item.message, item.options); });
scan(document.body);
new MutationObserver(records => {
  // Форма может скрыть/снова показать прежний текст в одном синхронном обработчике.
  // Финальное hidden уже false; oldValue сохраняет факт повторного показа.
  for (const record of records) {
    if (record.type === "attributes" && record.attributeName === "hidden" && record.oldValue !== null
        && record.target instanceof HTMLElement && record.target.matches("[data-store-toast]")) {
      enhanced.delete(record.target);
    }
  }
  for (const record of records) {
    const target = record.target instanceof Element ? record.target : record.target.parentElement;
    const source = target?.closest<HTMLElement>("[data-store-toast]");
    if (source) enhance(source);
    for (const node of record.addedNodes) scan(node);
    for (const node of record.removedNodes) {
      if (!(node instanceof Element)) continue;
      const removed = node.matches("[data-store-toast]") ? [node] : [];
      removed.push(...node.querySelectorAll("[data-store-toast]"));
      for (const element of removed) {
        if (!element.isConnected) sourceEntries.get(element as HTMLElement)?.close();
      }
    }
  }
}).observe(document.body, {
  subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true,
  attributeFilter: ["data-toast-message", "data-toast-type", "data-toast-duration", "data-toast-href", "data-toast-id", "hidden", "class"],
});
window.addEventListener("resize", scheduleLayout, { passive: true });
