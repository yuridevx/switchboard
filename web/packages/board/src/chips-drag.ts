// Перестановка фильтров в ряду. Мышь: нажать на чип и повести (больше 4 px). Палец: удержать 300 мс, потом вести; обычное ведение —
// родная прокрутка ряда с инерцией. Клавиатура: Alt+← / Alt+→ на чипе. Escape — отмена.
// Пока чип в руке, DOM ряда не меняется: призрак — поверх списка (вне маски ряда), на месте чипа — пустое гнездо; гнездо и соседи едут
// transform'ом к посадочным местам. Отпустили — призрак садится в гнездо, порядок сохраняется. Выбранный фильтр не меняется.
import { startPress, type Press } from "./gesture.ts";
import { calm, edges, swallowClick } from "./drag-edge.ts";

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

type Gesture = {
  el: HTMLElement; row: HTMLElement; pid: number; x0: number; y0: number; x: number; active: boolean; landing?: boolean; press: Press;
  chips: HTMLElement[]; i: number; k: number; L: number[]; W: number[]; gap: number; pad: number; slots: number[]; grab: number; dy: number; ghost: HTMLElement; raf: number;
};

const chipsOf = (row: Element) => [...row.querySelectorAll<HTMLElement>(":scope > .fc")];

/** Перестановка чипов; снять — signal. */
export function attachChipDrag(api: ChipsApi, signal: AbortSignal) {
  const root = api.root;
  let S: Gesture | null = null;
  let deadPid: number | null = null; // жест отменён Escape: его отпускание не должно выбрать фильтр
  const on = { signal };

  function place() {
    const s = S!;
    const rr = s.row.getBoundingClientRect();
    const ar = root.getBoundingClientRect();
    const w = s.W[s.i];
    const x = Math.min(Math.max(s.x - s.grab, rr.left), rr.right - s.pad - w);
    s.ghost.style.translate = `${x - ar.left - root.clientLeft}px ${rr.top + s.dy - ar.top - root.clientTop}px`;
    // ближайшее посадочное место к левому краю призрака: порог посередине между местами
    const cx = x - rr.left + s.row.scrollLeft;
    let k = 0;
    s.slots.forEach((v, j) => {
      if (Math.abs(v - cx) < Math.abs(s.slots[k] - cx)) k = j;
    });
    if (k !== s.k) {
      s.k = k;
      shift();
    }
  }
  function shift() {
    const s = S!;
    const d = s.W[s.i] + s.gap;
    s.chips.forEach((c, j) => {
      const t = j === s.i ? s.slots[s.k] - s.L[s.i] : j > s.i && j <= s.k ? -d : j < s.i && j >= s.k ? d : 0;
      c.style.transform = t ? `translateX(${t}px)` : "";
    });
  }
  function tick() {
    const s = S;
    if (!s || s.landing) return;
    const rr = s.row.getBoundingClientRect();
    const { near, far } = edges(s.x, rr.left, rr.right, EDGE);
    const depth = near > 0 ? -near : far > 0 ? far : 0;
    if (depth) {
      const f = Math.min(1, Math.abs(depth) / EDGE);
      s.row.scrollLeft += Math.sign(depth) * Math.ceil(f * f * SPEED);
    }
    place();
    s.raf = requestAnimationFrame(tick);
  }
  function begin() {
    const s = S!;
    const row = s.row;
    const rr = row.getBoundingClientRect();
    s.press.cancel();
    s.active = true;
    s.chips = chipsOf(row);
    s.i = s.k = s.chips.indexOf(s.el);
    const rects = s.chips.map((c) => c.getBoundingClientRect());
    const er = rects[s.i];
    s.L = rects.map((r) => r.left - rr.left + row.scrollLeft);
    s.W = rects.map((r) => r.width);
    const cs = getComputedStyle(row);
    s.gap = parseFloat(cs.columnGap) || 0;
    s.pad = parseFloat(cs.paddingRight) || 0;
    s.slots = s.chips.map((_, k) => (k <= s.i ? s.L[k] : s.L[k] + s.W[k] - s.W[s.i]));
    s.grab = Math.min(Math.max(s.x0 - er.left, 0), er.width);
    s.dy = er.top - rr.top;
    const g = s.el.cloneNode(true) as HTMLElement;
    for (const a of ["data-fid", "role", "title", "id"]) g.removeAttribute(a);
    g.setAttribute("aria-hidden", "true");
    g.tabIndex = -1;
    g.classList.add("fc-ghost");
    g.style.width = er.width + "px";
    g.style.height = er.height + "px";
    s.ghost = g;
    root.appendChild(g);
    root.classList.add("reordering");
    api.reordering(true);
    row.classList.add("fc-sorting");
    s.el.classList.add("fc-slot");
    try {
      s.el.setPointerCapture(s.pid);
    } catch {
      /* указатель уже ушёл */
    }
    place();
    void g.getBoundingClientRect(); // зафиксировать исходный вид — подъём анимируется
    g.classList.add("lifted");
    s.raf = requestAnimationFrame(tick);
  }
  function land(apply: boolean) {
    const s = S!;
    s.landing = true;
    cancelAnimationFrame(s.raf);
    try {
      s.el.releasePointerCapture(s.pid);
    } catch {
      /* захват уже снят */
    }
    if (!apply && s.k !== s.i) {
      s.k = s.i;
      shift();
    }
    const rr = s.row.getBoundingClientRect();
    const ar = root.getBoundingClientRect();
    s.ghost.classList.add("landing");
    s.ghost.classList.remove("lifted");
    s.ghost.style.translate = `${rr.left + s.slots[s.k] - s.row.scrollLeft - ar.left - root.clientLeft}px ${rr.top + s.dy - ar.top - root.clientTop}px`;
    setTimeout(
      () => {
        const ids = s.chips.map((c) => c.dataset.fid!);
        const [id] = ids.splice(s.i, 1);
        ids.splice(s.k, 0, id);
        S = null;
        s.ghost.remove();
        root.classList.remove("reordering");
        api.reordering(false);
        if (s.k !== s.i) api.place(ids);
        api.redraw();
      },
      calm() ? 0 : LAND_MS,
    );
  }

  root.addEventListener(
    "pointerdown",
    (e) => {
      const el = (e.target as Element).closest<HTMLElement>(".fscroll > .fc");
      if (!el || S || e.button !== 0 || !e.isPrimary) return;
      S = { el, row: el.parentElement!, pid: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, active: false } as Gesture;
      S.press = startPress(e, () => {
        if (S && !S.active) begin();
      });
    },
    on,
  );
  window.addEventListener(
    "pointermove",
    (e) => {
      const s = S;
      if (!s || e.pointerId !== s.pid || s.landing) return;
      s.x = e.clientX;
      if (s.active) {
        place();
        return;
      }
      if (!s.press.move(e.clientX, e.clientY)) S = null;
    },
    on,
  );
  window.addEventListener(
    "pointerup",
    (e) => {
      if (e.pointerId === deadPid) {
        deadPid = null;
        swallowClick(api.root, signal); // следующий click по чипу не выбор
        return;
      }
      const s = S;
      if (!s || e.pointerId !== s.pid || s.landing) return;
      s.press.cancel();
      if (!s.active) {
        S = null; // нажатие без перетаскивания — обычный клик
        return;
      }
      swallowClick(api.root, signal); // следующий click по чипу не выбор
      land(true);
    },
    on,
  );
  window.addEventListener(
    "pointercancel",
    (e) => {
      const s = S;
      if (!s || e.pointerId !== s.pid || s.landing) return;
      s.press.cancel();
      if (s.active) land(false);
      else S = null;
    },
    on,
  );
  // чип в руке — палец не прокручивает ни ряд, ни страницу
  root.addEventListener("touchmove", (e) => void (S?.active && e.preventDefault()), { passive: false, signal });
  root.addEventListener("contextmenu", (e) => void (S && (e.target as Element).closest(".fscroll > .fc, .fc-ghost") && e.preventDefault()), on);
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && S?.active && !S.landing) {
        e.preventDefault();
        e.stopPropagation();
        deadPid = S.pid;
        land(false);
        return;
      }
      const el = (e.target as Element).closest?.<HTMLElement>(".fscroll > .fc");
      if (!el || !root.contains(el) || S || !e.altKey || e.ctrlKey || e.metaKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      e.preventDefault();
      const row = el.parentElement!;
      const ids = chipsOf(row).map((c) => c.dataset.fid!);
      const i = ids.indexOf(el.dataset.fid!);
      const k = i + (e.key === "ArrowLeft" ? -1 : 1);
      if (k < 0 || k >= ids.length) return;
      [ids[i], ids[k]] = [ids[k], ids[i]];
      const rr = row.getBoundingClientRect();
      const sl = row.scrollLeft;
      const was = new Map(chipsOf(row).map((c) => [c.dataset.fid!, c.getBoundingClientRect().left - rr.left + sl]));
      api.place(ids);
      api.redraw();
      const nr = root.querySelector<HTMLElement>(".fscroll")!;
      const moved = nr.querySelector<HTMLElement>(`:scope > .fc[data-fid=${JSON.stringify(el.dataset.fid!)}]`)!;
      moved.focus();
      moved.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      if (calm()) return;
      const nrr = nr.getBoundingClientRect();
      for (const c of chipsOf(nr)) {
        const dx = was.get(c.dataset.fid!)! - (c.getBoundingClientRect().left - nrr.left + nr.scrollLeft);
        if (!dx) continue;
        c.style.transform = `translateX(${dx}px)`;
        void c.getBoundingClientRect();
        c.classList.add("fc-glide");
        c.style.transform = "";
        c.addEventListener("transitionend", () => c.classList.remove("fc-glide"), { once: true });
      }
    },
    { capture: true, signal },
  );
  signal.addEventListener("abort", () => {
    if (S) cancelAnimationFrame(S.raf);
    S = null;
  });
}
