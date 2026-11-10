// Перетаскивание строк списка мышью и пальцем: палец — после удержания, Esc отменяет, у края список прокручивается сам, место показывает линия.
// Строки помечены data-drag-id и data-drag-group, заголовки групп — data-drop-group.
import { useEffect, useRef, useState } from "react";
import { dropTarget } from "./work.ts";

const HOLD_MS = 350, START_PX = 5, CANCEL_PX = 9, EDGE_PX = 48, SCROLL_PX = 14;

export type Drop = { id: string; before: string | null; group: string };

export function useRowDrag(o: { box: React.RefObject<HTMLElement | null>; onDrop: (d: Drop) => void; enabled?: boolean }) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [line, setLine] = useState<number | null>(null);
  const live = useRef<{ id: string; target: ReturnType<typeof dropTarget>; stop: () => void } | null>(null);
  const onDrop = useRef(o.onDrop);
  onDrop.current = o.onDrop;

  useEffect(() => () => live.current?.stop(), []);

  /** Положить на строку: начало жеста. */
  const onPointerDown = (id: string) => (e: React.PointerEvent) => {
    if (o.enabled === false || e.button !== 0 || (e.target as HTMLElement).closest("button, a, input, textarea, [role=menuitem]")) return;
    const box = o.box.current;
    if (!box) return;
    const touch = e.pointerType !== "mouse";
    const x0 = e.clientX, y0 = e.clientY;
    let started = false, y = y0, raf = 0;
    const hold = touch ? setTimeout(() => begin(), HOLD_MS) : null;

    const measure = () => {
      const top = box.getBoundingClientRect().top - box.scrollTop;
      const rows = [...box.querySelectorAll<HTMLElement>("[data-drag-id]")].map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.dataset.dragId!, group: el.dataset.dragGroup!, top: r.top, bottom: r.bottom };
      }).filter((r) => r.id !== id);
      const groups = [...box.querySelectorAll<HTMLElement>("[data-drop-group]")].map((el) => {
        const r = el.getBoundingClientRect();
        return { group: el.dataset.dropGroup!, top: r.top, bottom: r.bottom };
      });
      const t = dropTarget(rows, groups, y);
      live.current && (live.current.target = t);
      setLine(t ? t.lineY - top : null);
    };
    const scroll = () => {
      const r = box.getBoundingClientRect();
      if (y < r.top + EDGE_PX) box.scrollTop -= SCROLL_PX;
      else if (y > r.bottom - EDGE_PX) box.scrollTop += SCROLL_PX;
      measure();
      raf = requestAnimationFrame(scroll);
    };
    const begin = () => {
      started = true;
      setDragging(id);
      document.body.style.userSelect = "none";
      live.current = { id, target: null, stop };
      raf = requestAnimationFrame(scroll);
    };
    const move = (ev: PointerEvent) => {
      y = ev.clientY;
      const far = Math.hypot(ev.clientX - x0, ev.clientY - y0);
      if (!started) {
        // палец сдвинулся до конца удержания — это прокрутка, не перетаскивание
        if (touch) return void (far > CANCEL_PX && stop());
        if (far > START_PX) begin();
        return;
      }
      ev.preventDefault();
    };
    const up = () => {
      const t = live.current?.target;
      const was = started;
      stop();
      if (was) {
        // отпускание после перетаскивания — не щелчок по строке
        const kill = (ev: Event) => (ev.stopPropagation(), ev.preventDefault());
        window.addEventListener("click", kill, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", kill, true), 60);
      }
      if (was && t) onDrop.current({ id, before: t.before, group: t.group });
    };
    const key = (ev: KeyboardEvent) => ev.key === "Escape" && stop();
    const noScroll = (ev: TouchEvent) => started && ev.preventDefault();
    function stop() {
      if (hold) clearTimeout(hold);
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("keydown", key);
      window.removeEventListener("touchmove", noScroll);
      document.body.style.userSelect = "";
      live.current = null;
      setDragging(null);
      setLine(null);
    }
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("keydown", key);
    window.addEventListener("touchmove", noScroll, { passive: false });
  };

  return { dragging, line, onPointerDown };
}
