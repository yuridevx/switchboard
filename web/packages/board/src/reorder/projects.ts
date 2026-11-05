// Перестановка проектов: зона жеста на список, мышь и палец одним кодом; нажатие вне ручки отдаётся движку строк.
// Нажали на ⠿ и повели — заголовок поднимается карточкой ровно с того места, где схватили; строки схваченного проекта сворачиваются, на его месте — гнездо.
// DOM во время жеста не переставляется: соседи только сдвигаются transform по раскладке-модели, поэтому без рывков. «Без проекта» стоит последним и не двигается.
// Нажали и отпустили на ⠿ — меню проекта. У края — прокрутка, быстрее ближе к краю. Escape — отмена.
// Захват указателя и карточка — у постоянного элемента списка; закрытие экрана — отмена.
import { attachRows, type RowsApi } from "./rows.ts";
import { calm, capture, EDGE, edges, edgeSpeed, frameScroller, release, scrollerOf, viewOf } from "./press.ts";

const SLOP = 5;
const EASE = "cubic-bezier(0,0,.58,1)";
const LAND_EXTRA_MS = 20;
const STICK_EXTRA_MS = 80;
/** Прилипшие заголовки считаются только у разделов выше этой полосы. */
const STICK_BAND = 80;
/** Схватили у края: прокрутка включается, когда повели к нему дальше этого. */
const EDGE_ARM = 12;
/** Ниже последнего проекта список не едет: запас под тенью. */
const END_GAP = 14;

const duration = () => (calm() ? 0 : 220);

export type ProjectsApi = RowsApi & {
  /** новый порядок проектов: name перед before; before нет — в конец */
  place(name: string, before: string | null): void;
  /** нажатие на ⠿ без перетаскивания и Enter на ней */
  menu(name: string): void;
};

type Item = { el: HTMLElement; top: number; h: number };
type Tail = Item & { gap: number };
type Layout = { pos: Map<HTMLElement, number>; end: number };
/** Что собрано при подъёме. */
type Lift = {
  grab: number; cy0: number; cardY: number; lift: number; items: Item[]; tail: Tail[]; top: number; hd: number; yTop: number;
  k: number; k0: number; card: HTMLElement; layout: Layout; sy: number; expanded: boolean; raf: number;
};
type Drag = { name: string; lst: HTMLElement; sec: HTMLElement; sc: HTMLElement; pid: number; x0: number; y0: number; y: number; upOk: boolean; downOk: boolean; lift: Lift | null };

const sectionsOf = (lst: Element) => [...lst.querySelectorAll<HTMLElement>(':scope > .pjs:not([data-proj="~"])')];
const keyOf = (el: HTMLElement) => (el.classList.contains("pjs") ? "p:" + el.dataset.proj : el.className);
const setY = (el: HTMLElement, dy: number) => void (el.style.transform = dy ? `translateY(${dy}px)` : "");
const screenTops = (lst: HTMLElement) => new Map([...lst.children].map((el) => [keyOf(el as HTMLElement), el.getBoundingClientRect().top]));

/** Перестановка проектов и строк в списке; снять — signal. */
export function attachProjects(api: ProjectsApi, signal: AbortSignal) {
  const root = api.root;
  let drag: Drag | null = null;
  /** посадка идёт: новое нажатие доводит её сразу */
  let landing: (() => void) | null = null;
  const on = { signal };
  const rows = attachRows(api, signal, () => !!drag);
  const list = () => root.querySelector<HTMLElement>(".lst");

  /** Прилипший заголовок: sticky считает место без transform раздела, у сдвинутого раздела заголовок снова ставится к краю. */
  function fixSticky(lst: HTMLElement) {
    const edge = scrollerOf(lst).getBoundingClientRect().top;
    for (const s of lst.querySelectorAll<HTMLElement>(":scope > .pjs:not(.dnd-slot)")) {
      const head = s.querySelector<HTMLElement>(".pj")!;
      const cur = Number(head.dataset.dy) || 0;
      const r = s.getBoundingClientRect();
      let dy = 0;
      if (r.top < edge + STICK_BAND && r.bottom > edge) dy = Math.round(Math.max(r.top, Math.min(edge, r.bottom - head.offsetHeight)) - (head.getBoundingClientRect().top - cur));
      if (dy === cur) continue;
      head.style.translate = dy ? `0px ${dy}px` : "";
      if (dy) head.dataset.dy = String(dy);
      else delete head.dataset.dy;
    }
  }

  function fixStickyFor(ms: number) {
    const t0 = performance.now();
    const step = (now: number) => {
      const lst = list();
      if (!lst) return;
      fixSticky(lst);
      if (now - t0 < ms) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** После перерисовки всё, что сдвинулось, доезжает со старого места; open — проект, который разворачивается из заголовка. */
  function flip(before: Map<string, number>, open: string | null) {
    const lst = list();
    if (!lst || calm()) return;
    const sec = open ? sectionsOf(lst).find((s) => s.dataset.proj === open) : undefined;
    const fold = sec ? sec.offsetHeight - sec.querySelector<HTMLElement>(".pj")!.offsetHeight : 0;
    for (const el of lst.children as unknown as HTMLElement[]) {
      const was = before.get(keyOf(el));
      if (was == null) continue;
      const dy = Math.round(was - el.getBoundingClientRect().top);
      const unfolds = el === sec && fold > 0;
      if (!dy && !unfolds) continue;
      const from: Keyframe = { transform: `translateY(${dy}px)` };
      const to: Keyframe = { transform: "none" };
      if (unfolds) {
        from.clipPath = `inset(0 0 ${fold}px 0)`;
        to.clipPath = "inset(0 0 0 0)";
      }
      el.animate([from, to], { duration: duration(), easing: EASE });
    }
    fixStickyFor(duration() + STICK_EXTRA_MS);
  }

  /** Раскладка-модель: где каждый стоит при гнезде на месте k. */
  function layout(d: Drag, l: Lift): Layout {
    const pos = new Map<HTMLElement, number>();
    let y = l.yTop;
    for (const it of [...l.items.slice(0, l.k), { el: d.sec, h: l.hd }, ...l.items.slice(l.k)]) {
      pos.set(it.el, y);
      y += it.h;
    }
    for (const t of l.tail) {
      y += t.gap;
      pos.set(t.el, y);
      y += t.h;
    }
    return { pos, end: y };
  }

  /** Раскладку — на экран: соседи едут transition'ом, гнездо встаёт сразу и проявляется. */
  function arrange(d: Drag, l: Lift) {
    l.layout = layout(d, l);
    for (const it of [...l.items, ...l.tail]) setY(it.el, l.layout.pos.get(it.el)! - it.top);
    const sy = l.layout.pos.get(d.sec)! - l.top;
    if (sy === l.sy) return;
    l.sy = sy;
    setY(d.sec, sy);
    if (!calm()) d.sec.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, pseudoElement: "::after" });
  }

  /** Карточка — за пальцем с места хвата, в границах видимой части списка; место — по серединам соседей. */
  function follow(d: Drag, l: Lift) {
    const v = viewOf(d.sc);
    const rr = root.getBoundingClientRect();
    l.cardY = Math.min(Math.max(d.y - l.grab, Math.min(v.top, l.cy0)), Math.max(v.bottom - l.hd, l.cy0));
    l.card.style.translate = `0px ${l.cardY + l.lift - rr.top - root.clientTop}px`;
    const middle = l.cardY + l.hd / 2 - d.lst.getBoundingClientRect().top;
    const k = l.items.filter((it) => l.layout.pos.get(it.el)! + it.h / 2 < middle).length;
    if (k !== l.k) {
      l.k = k;
      arrange(d, l);
    }
    fixSticky(d.lst);
  }

  function lift(d: Drag) {
    const { lst, sec, sc } = d;
    const head = sec.querySelector<HTMLElement>(".pj")!;
    const hb = head.getBoundingClientRect();
    const full = sec.offsetHeight;
    const hh = head.offsetHeight;
    const hidden = hb.top - sec.getBoundingClientRect().top; // сколько проекта ушло за верхний край под прилипший заголовок
    const tops = new Map([...lst.children].map((el) => [el as HTMLElement, el.getBoundingClientRect().top]));
    lst.style.minHeight = lst.offsetHeight + "px"; // сворачивание не обрезает прокрутку — список не прыгает
    root.classList.add("reordering");
    api.reordering(true);
    lst.classList.add("dnd-on");
    sec.classList.add("dnd-slot");
    sec.style.height = hh + "px";
    if (hidden) sec.querySelectorAll<HTMLElement>(":scope > .bd-row, :scope > .mgrp").forEach((r) => (r.style.transform = `translateY(${-hidden}px)`));
    for (const el of lst.children as unknown as HTMLElement[]) {
      el.style.transition = "none";
      el.style.transform = "";
    }
    const sections = sectionsOf(lst);
    const items = sections.filter((s) => s !== sec).map((el) => ({ el, top: el.offsetTop, h: el.offsetHeight }));
    const last = sections[sections.length - 1];
    let bottom = last.offsetTop + last.offsetHeight;
    const tail = ([...lst.children] as HTMLElement[])
      .filter((el) => !sections.includes(el))
      .map((el) => {
        const t = { el, top: el.offsetTop, h: el.offsetHeight, gap: el.offsetTop - bottom };
        bottom = t.top + t.h;
        return t;
      });
    const top = sec.offsetTop;
    const yTop = sections[0].offsetTop;
    const k0 = items.filter((i) => i.top < top).length;
    // карточка: копия заголовка, ровные поля; содержимое — точно там же, где было
    const card = head.cloneNode(true) as HTMLElement;
    card.className = "pj dnd-card";
    card.setAttribute("aria-hidden", "true");
    card.inert = true;
    card.removeAttribute("data-proj");
    card.querySelectorAll("*").forEach((e) => {
      for (const a of ["data-proj", "tabindex", "id", "role"]) e.removeAttribute(a);
    });
    const rr = root.getBoundingClientRect();
    card.style.left = hb.left - rr.left - root.clientLeft + "px";
    card.style.width = hb.width + "px";
    root.appendChild(card);
    const l: Lift = {
      grab: d.y0 - hb.top,
      cy0: hb.top,
      cardY: 0,
      lift: parseFloat(getComputedStyle(head).paddingTop) - parseFloat(getComputedStyle(card).paddingTop) || 0,
      items,
      tail,
      top,
      hd: hh,
      yTop,
      k: k0,
      k0,
      card,
      layout: { pos: new Map(), end: 0 },
      sy: NaN,
      expanded: head.querySelector(".pj-t")!.getAttribute("aria-expanded") === "true",
      raf: 0,
    };
    l.layout = layout(d, l);
    // гнездо — ровно там, где был заголовок (и прилипший тоже)
    sc.scrollTop += lst.getBoundingClientRect().top + l.layout.pos.get(sec)! - hb.top;
    const lt = lst.getBoundingClientRect().top;
    for (const it of [...items, ...tail]) setY(it.el, tops.get(it.el)! - (lt + it.top));
    void lst.offsetHeight; // зафиксировать старые места
    for (const el of lst.children as unknown as HTMLElement[]) el.style.transition = "";
    l.sy = l.layout.pos.get(sec)! - l.top;
    setY(sec, l.sy);
    // свёртка: строки стираются снизу вверх вместе со следующим проектом, который едет на их место
    const rest = full - hh - hidden;
    if (rest > 0 && !calm()) sec.animate([{ clipPath: `inset(0 -9px ${-rest}px -9px)` }, { clipPath: "inset(0 -9px 0 -9px)" }], { duration: duration(), easing: EASE }).onfinish = () => sec.classList.add("dnd-folded");
    else sec.classList.add("dnd-folded");
    d.lift = l;
    follow(d, l);
    arrange(d, l);
    requestAnimationFrame(() => {
      card.classList.add("up");
      card.querySelector(".pj-t")?.setAttribute("aria-expanded", "false");
    });
    const scroll = frameScroller(sc);
    const frame = (now: number) => {
      if (drag !== d) return;
      // край включается, только когда к нему повели: схватили у края — список не убегает
      const v = viewOf(sc);
      const { near: up, far: down } = edges(d.y, v.top, v.bottom, EDGE);
      if (up <= 0 || d.y < d.y0 - EDGE_ARM) d.upOk = true;
      if (down <= 0 || d.y > d.y0 + EDGE_ARM) d.downOk = true;
      let speed = up > 0 && d.upOk ? -edgeSpeed(up) : down > 0 && d.downOk ? edgeSpeed(down) : 0;
      if (speed > 0 && lst.getBoundingClientRect().top + l.layout.end + END_GAP <= v.bottom) speed = 0;
      scroll(now, speed);
      follow(d, l);
      l.raf = requestAnimationFrame(frame);
    };
    l.raf = requestAnimationFrame(frame);
  }

  /** Конец: apply — сохранить показанный порядок, иначе вернуть всё на место; карточка садится в гнездо. */
  function end(apply: boolean) {
    const d = drag!;
    drag = null;
    release(root, d.pid);
    const l = d.lift;
    if (!l) {
      if (apply) api.menu(d.name);
      return;
    }
    cancelAnimationFrame(l.raf);
    if (!apply) {
      l.k = l.k0;
      arrange(d, l);
    }
    const moved = l.k !== l.k0;
    const nextId = l.items[l.k]?.el.dataset.proj ?? null;
    // посадка: в гнездо; гнездо за краем — карточка уходит к краю и тает
    const v = viewOf(d.sc);
    const rr = root.getBoundingClientRect();
    const y = d.lst.getBoundingClientRect().top + l.layout.pos.get(d.sec)!;
    l.card.classList.add("land");
    l.card.classList.remove("up");
    if (y < v.top - l.hd / 2 || y > v.bottom - l.hd / 2) l.card.style.opacity = "0";
    l.card.style.translate = `0px ${Math.min(Math.max(y, v.top - l.hd), v.bottom) + l.lift - rr.top - root.clientTop}px`;
    l.card.querySelector(".pj-t")?.setAttribute("aria-expanded", String(l.expanded));
    fixStickyFor(duration());
    const done = () => {
      if (landing !== done) return;
      landing = null;
      const before = screenTops(d.lst);
      l.card.remove();
      root.classList.remove("reordering");
      api.reordering(false);
      if (apply && moved) api.place(d.name, nextId);
      api.redraw();
      flip(before, l.expanded ? d.name : null);
    };
    landing = done;
    if (duration()) setTimeout(done, duration() + LAND_EXTRA_MS);
    else done();
  }

  root.addEventListener(
    "pointerdown",
    (e) => {
      if (landing) return void landing();
      const grip = (e.target as Element).closest<HTMLElement>(".grip");
      if (!grip) return void rows.press(e);
      if (drag || rows.busy() || !e.isPrimary || e.button !== 0) return;
      const sec = grip.closest<HTMLElement>(".pjs");
      const lst = sec?.parentElement;
      if (!sec || !lst) return;
      e.preventDefault(); // без выделения текста и фокуса мышью
      capture(root, e.pointerId);
      drag = { name: grip.dataset.proj!, lst, sec, sc: scrollerOf(lst), pid: e.pointerId, x0: e.clientX, y0: e.clientY, y: e.clientY, upOk: false, downOk: false, lift: null };
    },
    on,
  );
  root.addEventListener(
    "pointermove",
    (e) => {
      const d = drag;
      if (!d || e.pointerId !== d.pid) return;
      d.y = e.clientY;
      if (!d.lift) {
        if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < SLOP) return;
        lift(d);
      }
      follow(d, d.lift!);
    },
    on,
  );
  root.addEventListener("pointerup", (e) => void (drag && e.pointerId === drag.pid && end(true)), on);
  for (const type of ["pointercancel", "lostpointercapture"] as const) root.addEventListener(type, (e) => void (drag && e.pointerId === drag.pid && end(false)), on);
  document.addEventListener(
    "keydown",
    (e) => {
      if (!drag || e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      end(false);
    },
    { capture: true, signal },
  );
  // стрелки на ручке: на одно место выше или ниже; Enter и пробел — меню проекта
  root.addEventListener(
    "keydown",
    (e) => {
      const grip = (e.target as Element).closest?.<HTMLElement>(".grip");
      if (!grip || drag) return;
      const name = grip.dataset.proj!;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        return api.menu(name);
      }
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      if (landing) return void landing();
      const lst = grip.closest<HTMLElement>(".lst")!;
      const ids = sectionsOf(lst).map((s) => s.dataset.proj!);
      const i = ids.indexOf(name);
      if ((e.key === "ArrowUp" && i === 0) || (e.key === "ArrowDown" && i === ids.length - 1)) return;
      const before = screenTops(lst);
      api.place(name, e.key === "ArrowUp" ? ids[i - 1] : (ids[i + 2] ?? null));
      api.redraw();
      const again = root.querySelector<HTMLElement>(`.grip[data-proj=${JSON.stringify(name)}]`);
      if (!again) return;
      again.focus({ preventScroll: true });
      const v = viewOf(scrollerOf(again));
      const r = again.getBoundingClientRect();
      if (r.top < v.top || r.bottom > v.bottom) again.scrollIntoView({ block: "center" });
      else flip(before, null);
    },
    on,
  );
  // закрытие экрана посреди жеста — отмена
  signal.addEventListener("abort", () => {
    if (drag?.lift) cancelAnimationFrame(drag.lift.raf);
    drag = null;
    landing = null;
  });
}
