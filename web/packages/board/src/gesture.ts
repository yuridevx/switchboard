// Жесты списка: нажатие становится жестом по сдвигу или удержанию; проекты и чипы переставляет один сортировщик, строки — свой бросок.
// Разметка жеста живёт на элементах вне React: выборка списка в это время отдаёт прошлый ответ.
import type { PointerEvent as ReactPointerEvent } from "react";

const SLOP = 5;
const HOLD_MS = 300;
const EDGE = 40;
const EDGE_SPEED = 12;

export type Lifted = { move(x: number, y: number): void; drop(): void; cancel(): void };
type Scroller = { el: HTMLElement; axis: "x" | "y" };

/**
 * Нажатие: мышь и ручка — жест по сдвигу; палец с hold — по удержанию, а раньше сдвинулся — это прокрутка.
 * После жеста щелчка нет; у края список едет сам.
 */
export function press(e: ReactPointerEvent<HTMLElement>, o: { hold: boolean; scroller: Scroller; lift(x: number, y: number): Lifted }) {
  if (e.button !== 0) return;
  const { clientX: x0, clientY: y0, pointerId } = e;
  const byHold = o.hold && e.pointerType === "touch";
  let lifted: Lifted | null = null;
  let x = x0;
  let y = y0;
  let frame = 0;

  const noScroll = (ev: Event) => ev.preventDefault();
  const noClick = (ev: Event) => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  const listeners = { pointermove: onMove, pointerup: onUp, pointercancel: onCancel, keydown: onKey } as unknown as Record<string, EventListener>;
  function lift() {
    clearTimeout(timer);
    document.addEventListener("touchmove", noScroll, { passive: false });
    lifted = o.lift(x0, y0);
    lifted.move(x, y);
    frame = requestAnimationFrame(follow);
  }
  function follow() {
    const r = o.scroller.el.getBoundingClientRect();
    const [at, from, to] = o.scroller.axis === "x" ? [x, r.left, r.right] : [y, r.top, r.bottom];
    const near = at < from + EDGE ? at - from - EDGE : at > to - EDGE ? at - to + EDGE : 0;
    if (near && lifted) {
      const step = (near / EDGE) * EDGE_SPEED;
      if (o.scroller.axis === "x") o.scroller.el.scrollLeft += step;
      else o.scroller.el.scrollTop += step;
      lifted.move(x, y);
    }
    frame = requestAnimationFrame(follow);
  }
  function finish(act: (l: Lifted) => void) {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    for (const [type, fn] of Object.entries(listeners)) window.removeEventListener(type, fn);
    document.removeEventListener("touchmove", noScroll);
    if (!lifted) return;
    act(lifted);
    window.addEventListener("click", noClick, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", noClick, { capture: true }), 0);
  }
  function onMove(ev: PointerEvent) {
    if (ev.pointerId !== pointerId) return;
    x = ev.clientX;
    y = ev.clientY;
    if (lifted) lifted.move(x, y);
    else if (Math.hypot(x - x0, y - y0) >= SLOP) {
      if (byHold) finish(() => {});
      else lift();
    }
  }
  function onUp(ev: PointerEvent) {
    if (ev.pointerId === pointerId) finish((l) => l.drop());
  }
  function onCancel(ev: PointerEvent) {
    if (ev.pointerId === pointerId) finish((l) => l.cancel());
  }
  function onKey(ev: KeyboardEvent) {
    if (ev.key === "Escape") finish((l) => l.cancel());
  }
  const timer = byHold ? setTimeout(lift, HOLD_MS) : undefined;
  for (const [type, fn] of Object.entries(listeners)) window.addEventListener(type, fn);
}

/** Копия для жеста: без имён, по которым её нашли бы вместо настоящего, и вне фокуса. */
function copyOf(el: HTMLElement, cls: string): HTMLElement {
  const copy = el.cloneNode(true) as HTMLElement;
  for (const x of [copy, ...copy.querySelectorAll<HTMLElement>("*")]) for (const name of ["data-proj", "data-fid", "data-callsign", "role", "tabindex"]) x.removeAttribute(name);
  copy.classList.add(...cls.split(" "));
  copy.setAttribute("aria-hidden", "true");
  return copy;
}

/**
 * Сортировщик: элемент становится местом в ряду, копия идёт за пальцем, соседи расступаются.
 * Отпустили — копия садится на место, затем меняется порядок. Esc — садится на старое.
 */
export function sorter(o: {
  axis: "x" | "y";
  /** корень: копия лежит в нём и не едет вместе с рядом */
  root: HTMLElement;
  box: HTMLElement;
  item: HTMLElement;
  others: HTMLElement[];
  /** с чего копия и что в ней совпадает с настоящим под пальцем */
  source: HTMLElement;
  anchor?: string;
  cls: { copy: string; up: string; land: string; slot: string; box: string };
  /** ряд готов к жесту и обратно: складывание, классы корня */
  open?(): void;
  close?(): void;
  dress(copy: HTMLElement, at: { x: number; y: number }, size: DOMRect): void;
  put(copy: HTMLElement, main: number, cross: number): void;
  landMs: number;
  pointer: number;
  commit(index: number): void;
}): Lifted {
  const main = o.axis === "y" ? "top" : "left";
  const size = o.axis === "y" ? "height" : "width";
  const was = o.source.getBoundingClientRect();
  const root = o.root.getBoundingClientRect();
  const at = { x: was.left - root.left, y: was.top - root.top };
  const copy = copyOf(o.source, o.cls.copy);
  o.dress(copy, at, was);
  o.root.append(copy);
  const anchored = (el: HTMLElement) => (o.anchor ? el.querySelector(o.anchor)! : el).getBoundingClientRect()[main];
  // у копии свои отступы: под пальцем остаётся та же точка
  const inset = anchored(o.source) - was[main] - (anchored(copy) - copy.getBoundingClientRect()[main]);
  const start = (o.axis === "y" ? at.y : at.x) + inset;
  const cross = o.axis === "y" ? at.x : at.y;
  o.box.classList.add(o.cls.box);
  o.item.classList.add(...o.cls.slot.split(" "));
  o.open?.();
  o.put(copy, start, cross);
  requestAnimationFrame(() => copy.classList.contains(o.cls.land) || copy.classList.add(o.cls.up));

  const style = getComputedStyle(o.box);
  const gap = parseFloat(o.axis === "y" ? style.rowGap : style.columnGap) || 0;
  const slotSize = o.item.getBoundingClientRect()[size] + gap;
  const boxAt = () => o.box.getBoundingClientRect()[main];
  const spots = o.others.map((el) => {
    const r = el.getBoundingClientRect();
    return { el, at: r[main] - boxAt(), size: r[size] };
  });
  const home = spots.filter((s) => s.at < o.item.getBoundingClientRect()[main] - boxAt()).length;
  let index = home;

  const offset = (el: HTMLElement, by: number) => (el.style.transform = !by ? "" : o.axis === "y" ? `translateY(${by}px)` : `translateX(${by}px)`);
  function settle(i: number) {
    index = i;
    spots.forEach((s, k) => offset(s.el, k >= home && k < i ? -slotSize : k < home && k >= i ? slotSize : 0));
    const passed = (from: number, to: number) => spots.slice(from, to).reduce((n, s) => n + s.size + gap, 0);
    offset(o.item, i > home ? passed(home, i) : -passed(i, home));
  }
  function land(commit: boolean) {
    copy.classList.remove(o.cls.up);
    copy.classList.add(o.cls.land);
    o.put(copy, o.item.getBoundingClientRect()[main] - o.root.getBoundingClientRect()[main] + inset, cross);
    setTimeout(() => {
      if (commit && index !== home) o.commit(index);
      copy.remove();
      o.box.classList.remove(o.cls.box);
      o.item.classList.remove(...o.cls.slot.split(" "));
      for (const el of [o.item, ...o.others]) el.style.transform = "";
      o.close?.();
    }, o.landMs);
  }
  return {
    move(x, y) {
      const pos = start + (o.axis === "y" ? y : x) - o.pointer;
      o.put(copy, pos, cross);
      const center = pos - inset + was[size] / 2 + o.root.getBoundingClientRect()[main] - boxAt();
      settle(spots.filter((s) => s.at + s.size / 2 < center).length);
    },
    drop: () => land(true),
    cancel() {
      settle(home);
      land(false);
    },
  };
}

/** Строки блока едут вместе: копия за пальцем, линия показывает место, заголовок проекта — бросок в него. */
export function rowDrag(o: { root: HTMLElement; list: HTMLElement; row: HTMLElement; block: HTMLElement[]; y: number; drop(project: string, before: string | null): void; end(): void }): Lifted {
  const was = o.row.getBoundingClientRect();
  const root = o.root.getBoundingClientRect();
  const left = was.left - root.left;
  const top = was.top - root.top;
  for (const r of o.block) r.classList.add("dnd-row-out");
  o.root.classList.add("reordering");
  const copy = copyOf(o.row, "dnd-row-card");
  copy.setAttribute("inert", "");
  copy.style.width = `${was.width}px`;
  o.root.append(copy);
  const line = document.createElement("div");
  line.className = "dnd-row-line";
  line.style.left = `${left + 2}px`;
  line.style.width = `${was.width - 4}px`;
  o.root.append(line);
  let target: { project: string; before: string | null; head: HTMLElement | null } | null = null;

  /** Куда упадёт: первый заголовок или строка, чей низ ниже пальца; строка — перед ней или перед следующей. */
  function find(y: number) {
    const seq = [...o.list.querySelectorAll<HTMLElement>(".pjs > .pj, .pjs > .bd-row")].filter((el) => !o.block.includes(el));
    const hit = seq.findIndex((el) => y < el.getBoundingClientRect().bottom);
    const el = seq[hit] ?? seq.at(-1);
    if (!el) return null;
    const project = el.closest<HTMLElement>(".pjs")!.dataset.proj!;
    if (hit >= 0 && el.classList.contains("pj")) return { project, before: null, head: el, lineAt: 0 };
    const r = el.getBoundingClientRect();
    if (hit >= 0 && y < (r.top + r.bottom) / 2) return { project, before: el.dataset.callsign!, head: null, lineAt: r.top };
    const next = seq[seq.indexOf(el) + 1];
    return { project, before: next?.classList.contains("bd-row") ? next.dataset.callsign! : null, head: null, lineAt: r.bottom };
  }
  function clear() {
    copy.remove();
    line.remove();
    target?.head?.classList.remove("dnd-into");
    for (const r of o.block) r.classList.remove("dnd-row-out");
    o.root.classList.remove("reordering");
    o.end();
  }
  return {
    move(x, y) {
      copy.style.translate = `${left}px ${top + y - o.y}px`;
      const next = find(y);
      if (target?.head !== next?.head) {
        target?.head?.classList.remove("dnd-into");
        next?.head?.classList.add("dnd-into");
      }
      target = next;
      line.style.display = next && !next.head ? "" : "none";
      if (next && !next.head) line.style.top = `${next.lineAt - o.root.getBoundingClientRect().top - 1}px`;
    },
    drop() {
      if (target) o.drop(target.project, target.before);
      clear();
    },
    cancel: clear,
  };
}
