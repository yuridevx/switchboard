// Перестановка фильтров в ряду. Мышь: нажать на чип и повести. Палец: удержать, потом вести; обычное ведение — родная прокрутка ряда с инерцией.
// Клавиатура: Alt+← и Alt+→ на чипе. Escape — отмена. Выбранный фильтр не меняется.
// Пока чип в руке, DOM ряда не меняется: призрак — поверх списка (вне маски ряда), на месте чипа — пустое гнездо; гнездо и соседи едут
// transform'ом к посадочным местам. Отпустили — призрак садится в гнездо, порядок сохраняется.
import { calm, capture, edges, release, startPress, swallowClick, type Press } from "./press.ts";

const EDGE = 44;
const SPEED = 14;
const LAND_MS = 200;

export type ChipsApi = {
  /** постоянный элемент списка: не перерисовывается */
  root: HTMLElement;
  /** новый порядок ряда */
  place(ids: string[]): void;
  /** перестановка началась или кончилась: пока идёт, виды не рисуют */
  reordering(on: boolean): void;
  redraw(): void;
};

type Lift = { chips: HTMLElement[]; from: number; to: number; lefts: number[]; widths: number[]; gap: number; pad: number; slots: number[]; grab: number; dy: number; ghost: HTMLElement; raf: number };
type Gesture = { el: HTMLElement; row: HTMLElement; pid: number; x0: number; x: number; press: Press; lift: Lift | null; landing: boolean };

const chipsOf = (row: Element) => [...row.querySelectorAll<HTMLElement>(":scope > .fc")];
const CHIP = ".fscroll > .fc";

export function attachChips(api: ChipsApi, signal: AbortSignal) {
  const root = api.root;
  let g: Gesture | null = null;
  /** жест отменён Escape: его отпускание не должно выбрать фильтр */
  let cancelledPid: number | null = null;
  const on = { signal };

  /** Гнездо и соседи — на места при текущем выборе. */
  function shift({ chips, from, to, slots, lefts, widths, gap }: Lift) {
    const d = widths[from] + gap;
    chips.forEach((c, j) => {
      const t = j === from ? slots[to] - lefts[from] : j > from && j <= to ? -d : j < from && j >= to ? d : 0;
      c.style.transform = t ? `translateX(${t}px)` : "";
    });
  }

  /** Призрак — за указателем в границах ряда; посадочное место — ближайшее к его левому краю. */
  function follow(s: Gesture, l: Lift) {
    const rr = s.row.getBoundingClientRect();
    const ar = root.getBoundingClientRect();
    const x = Math.min(Math.max(s.x - l.grab, rr.left), rr.right - l.pad - l.widths[l.from]);
    l.ghost.style.translate = `${x - ar.left - root.clientLeft}px ${rr.top + l.dy - ar.top - root.clientTop}px`;
    const at = x - rr.left + s.row.scrollLeft;
    const to = l.slots.reduce((best, v, j) => (Math.abs(v - at) < Math.abs(l.slots[best] - at) ? j : best), 0);
    if (to !== l.to) {
      l.to = to;
      shift(l);
    }
  }

  function frame() {
    const s = g;
    if (!s?.lift || s.landing) return;
    const rr = s.row.getBoundingClientRect();
    const { near, far } = edges(s.x, rr.left, rr.right, EDGE);
    const depth = near > 0 ? -near : far > 0 ? far : 0;
    if (depth) s.row.scrollLeft += Math.sign(depth) * Math.ceil(Math.min(1, Math.abs(depth) / EDGE) ** 2 * SPEED);
    follow(s, s.lift);
    s.lift.raf = requestAnimationFrame(frame);
  }

  function lift(s: Gesture) {
    const row = s.row;
    s.press.cancel();
    const rr = row.getBoundingClientRect();
    const chips = chipsOf(row);
    const from = chips.indexOf(s.el);
    const rects = chips.map((c) => c.getBoundingClientRect());
    const er = rects[from];
    const lefts = rects.map((r) => r.left - rr.left + row.scrollLeft);
    const widths = rects.map((r) => r.width);
    const cs = getComputedStyle(row);
    const ghost = s.el.cloneNode(true) as HTMLElement;
    for (const a of ["data-fid", "role", "title", "id"]) ghost.removeAttribute(a);
    ghost.setAttribute("aria-hidden", "true");
    ghost.tabIndex = -1;
    ghost.classList.add("fc-ghost");
    ghost.style.width = er.width + "px";
    ghost.style.height = er.height + "px";
    root.appendChild(ghost);
    const l: Lift = {
      chips,
      from,
      to: from,
      lefts,
      widths,
      gap: parseFloat(cs.columnGap) || 0,
      pad: parseFloat(cs.paddingRight) || 0,
      slots: chips.map((_, k) => (k <= from ? lefts[k] : lefts[k] + widths[k] - widths[from])),
      grab: Math.min(Math.max(s.x0 - er.left, 0), er.width),
      dy: er.top - rr.top,
      ghost,
      raf: 0,
    };
    s.lift = l;
    root.classList.add("reordering");
    api.reordering(true);
    row.classList.add("fc-sorting");
    s.el.classList.add("fc-slot");
    capture(s.el, s.pid);
    follow(s, l);
    void ghost.getBoundingClientRect(); // зафиксировать исходный вид — подъём анимируется
    ghost.classList.add("lifted");
    l.raf = requestAnimationFrame(frame);
  }

  function land(s: Gesture, l: Lift, apply: boolean) {
    s.landing = true;
    cancelAnimationFrame(l.raf);
    release(s.el, s.pid);
    if (!apply && l.to !== l.from) {
      l.to = l.from;
      shift(l);
    }
    const rr = s.row.getBoundingClientRect();
    const ar = root.getBoundingClientRect();
    l.ghost.classList.add("landing");
    l.ghost.classList.remove("lifted");
    l.ghost.style.translate = `${rr.left + l.slots[l.to] - s.row.scrollLeft - ar.left - root.clientLeft}px ${rr.top + l.dy - ar.top - root.clientTop}px`;
    setTimeout(
      () => {
        const ids = l.chips.map((c) => c.dataset.fid!);
        const [id] = ids.splice(l.from, 1);
        ids.splice(l.to, 0, id);
        g = null;
        l.ghost.remove();
        root.classList.remove("reordering");
        api.reordering(false);
        if (l.to !== l.from) api.place(ids);
        api.redraw();
      },
      calm() ? 0 : LAND_MS,
    );
  }

  root.addEventListener(
    "pointerdown",
    (e) => {
      const el = (e.target as Element).closest<HTMLElement>(CHIP);
      if (!el || g || e.button !== 0 || !e.isPrimary) return;
      const s: Gesture = { el, row: el.parentElement!, pid: e.pointerId, x0: e.clientX, x: e.clientX, lift: null, landing: false, press: startPress(e, () => g === s && !s.lift && lift(s)) };
      g = s;
    },
    on,
  );
  const mine = (e: PointerEvent) => (g && e.pointerId === g.pid && !g.landing ? g : null);
  window.addEventListener(
    "pointermove",
    (e) => {
      const s = mine(e);
      if (!s) return;
      s.x = e.clientX;
      if (s.lift) follow(s, s.lift);
      else if (!s.press.move(e.clientX, e.clientY)) g = null;
    },
    on,
  );
  window.addEventListener(
    "pointerup",
    (e) => {
      if (e.pointerId === cancelledPid) {
        cancelledPid = null;
        swallowClick(root, signal);
        return;
      }
      const s = mine(e);
      if (!s) return;
      s.press.cancel();
      if (!s.lift) {
        g = null; // нажатие без перетаскивания — обычный клик
        return;
      }
      swallowClick(root, signal);
      land(s, s.lift, true);
    },
    on,
  );
  window.addEventListener(
    "pointercancel",
    (e) => {
      const s = mine(e);
      if (!s) return;
      s.press.cancel();
      if (s.lift) land(s, s.lift, false);
      else g = null;
    },
    on,
  );
  // чип в руке — палец не прокручивает ни ряд, ни страницу
  root.addEventListener("touchmove", (e) => void (g?.lift && e.preventDefault()), { passive: false, signal });
  root.addEventListener("contextmenu", (e) => void (g && (e.target as Element).closest(`${CHIP}, .fc-ghost`) && e.preventDefault()), on);

  /** Alt+стрелка: соседний чип меняется местами, остальные доезжают плавно. */
  function moveByKey(el: HTMLElement, dir: -1 | 1) {
    const row = el.parentElement!;
    const ids = chipsOf(row).map((c) => c.dataset.fid!);
    const i = ids.indexOf(el.dataset.fid!);
    const k = i + dir;
    if (k < 0 || k >= ids.length) return;
    [ids[i], ids[k]] = [ids[k], ids[i]];
    const offsets = (r: Element) => {
      const left = r.getBoundingClientRect().left;
      return new Map(chipsOf(r).map((c) => [c.dataset.fid!, c.getBoundingClientRect().left - left + r.scrollLeft]));
    };
    const was = offsets(row);
    api.place(ids);
    api.redraw();
    const next = root.querySelector<HTMLElement>(".fscroll")!;
    const moved = next.querySelector<HTMLElement>(`:scope > .fc[data-fid=${JSON.stringify(el.dataset.fid!)}]`)!;
    moved.focus();
    moved.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    if (calm()) return;
    const now = offsets(next);
    for (const c of chipsOf(next)) {
      const dx = was.get(c.dataset.fid!)! - now.get(c.dataset.fid!)!;
      if (!dx) continue;
      c.style.transform = `translateX(${dx}px)`;
      void c.getBoundingClientRect();
      c.classList.add("fc-glide");
      c.style.transform = "";
      c.addEventListener("transitionend", () => c.classList.remove("fc-glide"), { once: true });
    }
  }

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && g?.lift && !g.landing) {
        e.preventDefault();
        e.stopPropagation();
        cancelledPid = g.pid;
        land(g, g.lift, false);
        return;
      }
      const el = (e.target as Element).closest?.<HTMLElement>(CHIP);
      if (!el || !root.contains(el) || g || !e.altKey || e.ctrlKey || e.metaKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      e.preventDefault();
      moveByKey(el, e.key === "ArrowLeft" ? -1 : 1);
    },
    { capture: true, signal },
  );
  signal.addEventListener("abort", () => {
    if (g?.lift) cancelAnimationFrame(g.lift.raf);
    g = null;
  });
}
