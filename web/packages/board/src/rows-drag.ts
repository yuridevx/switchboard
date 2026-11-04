// Перестановка строк между проектами и внутри них; зону жеста держит движок проектов.
// Строка: мышь — нажать и повести, палец — удержать (начало жеста — startPress, как у фильтров). Строка поднимается копией, линия показывает место; родитель едет блоком
// с дочерними. На свёрнутый проект можно бросать: строка встаёт в его конец. Плоский список и группы по машинам порядок только читают: api.rowsMove() — false.
import { EDGE, edges, edgeSpeed, scrollerOf, swallowClick, viewOf } from "./drag-edge.ts";
import { startPress, type Press } from "./gesture.ts";

export type RowsApi = {
  /** постоянный элемент списка: не перерисовывается */
  root: HTMLElement;
  /** можно ли сейчас переставлять строки */
  rowsMove(): boolean;
  /** поставить блок строк в проект перед before; before нет — в конец; shown — показанные строки проекта */
  placeRows(block: string[], project: string, before: string | null, shown: string[]): void;
  /** перестановка началась или кончилась: пока идёт, виды не рисуют */
  reordering(on: boolean): void;
  /** перерисовать список сейчас */
  redraw(): void;
};

/** Перестановка строк в списке; нажатие отдаёт движок проектов; снять — signal. */
export function attachRowDrag(api: RowsApi, signal: AbortSignal, projectBusy: () => boolean) {
  const root = api.root;
  const on = { signal };
  type Target = { project: string; before: string | null; line: number | null; head: HTMLElement | null };
  type RowDrag = { el: HTMLElement; pid: number; x0: number; y0: number; x: number; y: number; grabX: number; grabY: number; press: Press; active: boolean; block: Set<HTMLElement>; ghost: HTMLElement; line: HTMLElement; lst: HTMLElement; sc: HTMLElement; to: Target | null; raf: number; ts: number; acc: number };
  let row: RowDrag | null = null;

  /** Блок: строка и её дочерние — строки с большим отступом сразу под ней. */
  function blockOf(el: HTMLElement): HTMLElement[] {
    const depth = (x: HTMLElement) => parseFloat(x.style.paddingLeft) || 0;
    const out = [el];
    for (let n = el.nextElementSibling as HTMLElement | null; n?.classList.contains("bd-row") && depth(n) > depth(el); n = n.nextElementSibling as HTMLElement | null) out.push(n);
    return out;
  }

  function press(e: PointerEvent) {
    const el = (e.target as Element).closest<HTMLElement>(".bd-row");
    if (!el || projectBusy() || row || !e.isPrimary || e.button !== 0 || !api.rowsMove()) return;
    const lst = el.closest<HTMLElement>(".lst");
    if (!lst) return;
    row = { el, pid: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, active: false, lst, sc: scrollerOf(lst), to: null, press: startPress(e, () => row && !row.active && beginRow(row)) } as RowDrag;
  }

  function beginRow(d: RowDrag) {
    d.active = true;
    try {
      root.setPointerCapture(d.pid);
    } catch {
      /* указатель уже ушёл */
    }
    d.block = new Set(blockOf(d.el));
    const r = d.el.getBoundingClientRect();
    d.grabX = d.x0 - r.left;
    d.grabY = d.y0 - r.top;
    root.classList.add("reordering");
    api.reordering(true);
    for (const x of d.block) x.classList.add("dnd-row-out");
    const g = (d.ghost = d.el.cloneNode(true) as HTMLElement);
    g.removeAttribute("data-callsign");
    g.classList.add("dnd-row-card");
    g.setAttribute("aria-hidden", "true");
    g.inert = true;
    g.style.width = r.width + "px";
    root.appendChild(g);
    const line = (d.line = document.createElement("div"));
    line.className = "dnd-row-line";
    root.appendChild(line);
    d.ts = 0;
    d.acc = 0;
    followRow(d);
    const tick = (ts: number) => {
      if (row !== d) return;
      const dt = d.ts ? Math.min(50, ts - d.ts) : 0;
      d.ts = ts;
      const v = viewOf(d.sc);
      const { near: up, far: down } = edges(d.y, v.top, v.bottom, EDGE);
      const speed = up > 0 ? -edgeSpeed(up) : down > 0 ? edgeSpeed(down) : 0;
      d.acc = speed ? d.acc + (speed * dt) / 1000 : 0;
      const step = Math.trunc(d.acc);
      if (step) {
        d.sc.scrollTop += step;
        d.acc -= step;
        followRow(d);
      }
      d.raf = requestAnimationFrame(tick);
    };
    d.raf = requestAnimationFrame(tick);
  }

  /** Куда встанет строка при этой высоте указателя: свёрнутый проект — в конец; иначе перед первой строкой, чья середина ниже. */
  function targetAt(d: RowDrag): Target | null {
    const secs = [...d.lst.querySelectorAll<HTMLElement>(":scope > .pjs")];
    const first = secs[0];
    if (!first) return null;
    const sec = secs.find((s) => d.y < s.getBoundingClientRect().bottom) ?? secs[secs.length - 1];
    const project = sec.dataset.proj!;
    const rows = [...sec.querySelectorAll<HTMLElement>(":scope > .bd-row")].filter((x) => !d.block.has(x));
    if (!rows.length) return { project, before: null, line: null, head: sec.querySelector<HTMLElement>(".pj") };
    const next = rows.find((x) => {
      const b = x.getBoundingClientRect();
      return d.y < b.top + b.height / 2;
    });
    const anchor = next ?? rows[rows.length - 1];
    const b = anchor.getBoundingClientRect();
    return { project, before: next ? next.dataset.callsign! : null, line: next ? b.top : b.bottom, head: null };
  }

  function followRow(d: RowDrag) {
    const rr = root.getBoundingClientRect();
    d.ghost.style.translate = `${d.x - d.grabX - rr.left - root.clientLeft}px ${d.y - d.grabY - rr.top - root.clientTop}px`;
    d.to = targetAt(d);
    d.line.style.display = d.to?.line == null ? "none" : "";
    if (d.to?.line != null) {
      const l = d.lst.getBoundingClientRect();
      d.line.style.left = l.left - rr.left - root.clientLeft + 8 + "px";
      d.line.style.width = l.width - 16 + "px";
      d.line.style.top = d.to.line - rr.top - root.clientTop - 1 + "px";
    }
    for (const h of d.lst.querySelectorAll<HTMLElement>(".pj.dnd-into")) if (h !== d.to?.head) h.classList.remove("dnd-into");
    d.to?.head?.classList.add("dnd-into");
  }

  function endRow(ok: boolean) {
    const d = row;
    if (!d) return;
    row = null;
    d.press.cancel();
    if (!d.active) return;
    cancelAnimationFrame(d.raf);
    try {
      root.releasePointerCapture(d.pid);
    } catch {
      /* захват уже снят */
    }
    // клик после жеста сессию не открывает
    swallowClick(root, signal);
    d.ghost.remove();
    d.line.remove();
    d.lst.querySelector(".pj.dnd-into")?.classList.remove("dnd-into");
    for (const x of d.block) x.classList.remove("dnd-row-out");
    root.classList.remove("reordering");
    api.reordering(false);
    const to = d.to;
    if (ok && to) {
      const shown = [...d.lst.querySelectorAll<HTMLElement>(`:scope > .pjs[data-proj=${JSON.stringify(to.project)}] > .bd-row`)].map((x) => x.dataset.callsign!);
      api.placeRows([...d.block].map((x) => x.dataset.callsign!), to.project, to.before, shown);
    }
    api.redraw();
  }

  window.addEventListener(
    "pointermove",
    (e) => {
      const d = row;
      if (!d || e.pointerId !== d.pid) return;
      d.x = e.clientX;
      d.y = e.clientY;
      if (d.active) return followRow(d);
      if (!d.press.move(e.clientX, e.clientY)) row = null;
    },
    on,
  );
  window.addEventListener("pointerup", (e) => void (row && e.pointerId === row.pid && endRow(true)), on);
  window.addEventListener("pointercancel", (e) => void (row && e.pointerId === row.pid && endRow(false)), on);
  // строка в руке — палец не прокручивает список, меню браузера не всплывает
  root.addEventListener("touchmove", (e) => void (row?.active && e.preventDefault()), { passive: false, signal });
  root.addEventListener("contextmenu", (e) => void (row && e.preventDefault()), on);
  document.addEventListener(
    "keydown",
    (e) => {
      if (!row?.active || e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      endRow(false);
    },
    { capture: true, signal },
  );

  signal.addEventListener("abort", () => {
    if (row) {
      row.press.cancel();
      cancelAnimationFrame(row.raf);
    }
    row = null;
  });

  return { press, busy: () => !!row };
}
