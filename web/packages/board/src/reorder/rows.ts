// Перестановка строк между проектами и внутри них; зону жеста держит движок проектов.
// Строка: мышь — нажать и повести, палец — удержать. Строка поднимается копией, линия показывает место; родитель едет блоком с дочерними.
// На свёрнутый проект можно бросать: строка встаёт в его конец. Плоский список и группы по машинам порядок только читают.
import { capture, EDGE, edges, edgeSpeed, frameScroller, release, scrollerOf, startPress, swallowClick, viewOf, type Press } from "./press.ts";

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

type Target = { project: string; before: string | null; line: number | null; head: HTMLElement | null };
type Lift = { block: Set<HTMLElement>; ghost: HTMLElement; line: HTMLElement; grabX: number; grabY: number; to: Target | null; raf: number };
type Drag = { el: HTMLElement; pid: number; x0: number; y0: number; x: number; y: number; lst: HTMLElement; sc: HTMLElement; press: Press; lift: Lift | null };

/** Блок: строка и её дочерние — строки с большим отступом сразу под ней. */
function blockOf(el: HTMLElement): HTMLElement[] {
  const depth = (x: HTMLElement) => parseFloat(x.style.paddingLeft) || 0;
  const out = [el];
  for (let n = el.nextElementSibling as HTMLElement | null; n?.classList.contains("bd-row") && depth(n) > depth(el); n = n.nextElementSibling as HTMLElement | null) out.push(n);
  return out;
}

/** Куда встанет строка при этой высоте указателя: свёрнутый проект — в конец; иначе перед первой строкой, чья середина ниже. */
function targetAt(lst: HTMLElement, y: number, block: Set<HTMLElement>): Target | null {
  const sections = [...lst.querySelectorAll<HTMLElement>(":scope > .pjs")];
  if (!sections.length) return null;
  const sec = sections.find((s) => y < s.getBoundingClientRect().bottom) ?? sections[sections.length - 1];
  const project = sec.dataset.proj!;
  const rows = [...sec.querySelectorAll<HTMLElement>(":scope > .bd-row")].filter((x) => !block.has(x));
  if (!rows.length) return { project, before: null, line: null, head: sec.querySelector<HTMLElement>(".pj") };
  const next = rows.find((x) => {
    const b = x.getBoundingClientRect();
    return y < b.top + b.height / 2;
  });
  const b = (next ?? rows[rows.length - 1]).getBoundingClientRect();
  return { project, before: next ? next.dataset.callsign! : null, line: next ? b.top : b.bottom, head: null };
}

/** Перестановка строк; нажатие отдаёт движок проектов; снять — signal. */
export function attachRows(api: RowsApi, signal: AbortSignal, projectBusy: () => boolean) {
  const root = api.root;
  const on = { signal };
  let d: Drag | null = null;

  function press(e: PointerEvent) {
    const el = (e.target as Element).closest<HTMLElement>(".bd-row");
    if (!el || projectBusy() || d || !e.isPrimary || e.button !== 0 || !api.rowsMove()) return;
    const lst = el.closest<HTMLElement>(".lst");
    if (!lst) return;
    const s: Drag = { el, pid: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, lst, sc: scrollerOf(lst), lift: null, press: startPress(e, () => d === s && !s.lift && lift(s)) };
    d = s;
  }

  function follow(s: Drag, l: Lift) {
    const rr = root.getBoundingClientRect();
    l.ghost.style.translate = `${s.x - l.grabX - rr.left - root.clientLeft}px ${s.y - l.grabY - rr.top - root.clientTop}px`;
    l.to = targetAt(s.lst, s.y, l.block);
    const at = l.to?.line;
    l.line.style.display = at == null ? "none" : "";
    if (at != null) {
      const box = s.lst.getBoundingClientRect();
      l.line.style.left = box.left - rr.left - root.clientLeft + 8 + "px";
      l.line.style.width = box.width - 16 + "px";
      l.line.style.top = at - rr.top - root.clientTop - 1 + "px";
    }
    for (const h of s.lst.querySelectorAll<HTMLElement>(".pj.dnd-into")) if (h !== l.to?.head) h.classList.remove("dnd-into");
    l.to?.head?.classList.add("dnd-into");
  }

  function lift(s: Drag) {
    capture(root, s.pid);
    const block = new Set(blockOf(s.el));
    const r = s.el.getBoundingClientRect();
    root.classList.add("reordering");
    api.reordering(true);
    for (const x of block) x.classList.add("dnd-row-out");
    const ghost = s.el.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("data-callsign");
    ghost.classList.add("dnd-row-card");
    ghost.setAttribute("aria-hidden", "true");
    ghost.inert = true;
    ghost.style.width = r.width + "px";
    root.appendChild(ghost);
    const line = document.createElement("div");
    line.className = "dnd-row-line";
    root.appendChild(line);
    const l: Lift = { block, ghost, line, grabX: s.x0 - r.left, grabY: s.y0 - r.top, to: null, raf: 0 };
    s.lift = l;
    follow(s, l);
    const scroll = frameScroller(s.sc);
    const frame = (now: number) => {
      if (d !== s) return;
      const v = viewOf(s.sc);
      const { near: up, far: down } = edges(s.y, v.top, v.bottom, EDGE);
      if (scroll(now, up > 0 ? -edgeSpeed(up) : down > 0 ? edgeSpeed(down) : 0)) follow(s, l);
      l.raf = requestAnimationFrame(frame);
    };
    l.raf = requestAnimationFrame(frame);
  }

  function end(apply: boolean) {
    const s = d;
    if (!s) return;
    d = null;
    s.press.cancel();
    const l = s.lift;
    if (!l) return;
    cancelAnimationFrame(l.raf);
    release(root, s.pid);
    // клик после жеста сессию не открывает
    swallowClick(root, signal);
    l.ghost.remove();
    l.line.remove();
    s.lst.querySelector(".pj.dnd-into")?.classList.remove("dnd-into");
    for (const x of l.block) x.classList.remove("dnd-row-out");
    root.classList.remove("reordering");
    api.reordering(false);
    if (apply && l.to) {
      const shown = [...s.lst.querySelectorAll<HTMLElement>(`:scope > .pjs[data-proj=${JSON.stringify(l.to.project)}] > .bd-row`)].map((x) => x.dataset.callsign!);
      api.placeRows([...l.block].map((x) => x.dataset.callsign!), l.to.project, l.to.before, shown);
    }
    api.redraw();
  }

  window.addEventListener(
    "pointermove",
    (e) => {
      const s = d;
      if (!s || e.pointerId !== s.pid) return;
      s.x = e.clientX;
      s.y = e.clientY;
      if (s.lift) follow(s, s.lift);
      else if (!s.press.move(e.clientX, e.clientY)) d = null;
    },
    on,
  );
  window.addEventListener("pointerup", (e) => void (d && e.pointerId === d.pid && end(true)), on);
  window.addEventListener("pointercancel", (e) => void (d && e.pointerId === d.pid && end(false)), on);
  // строка в руке — палец не прокручивает список, меню браузера не всплывает
  root.addEventListener("touchmove", (e) => void (d?.lift && e.preventDefault()), { passive: false, signal });
  root.addEventListener("contextmenu", (e) => void (d && e.preventDefault()), on);
  document.addEventListener(
    "keydown",
    (e) => {
      if (!d?.lift || e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      end(false);
    },
    { capture: true, signal },
  );
  signal.addEventListener("abort", () => {
    d?.press.cancel();
    if (d?.lift) cancelAnimationFrame(d.lift.raf);
    d = null;
  });

  return { press, busy: () => !!d };
}
