// Перестановка проектов и строк: одна зона жеста на список, мышь и палец одним кодом (pointer), стрелки на ручке проекта — с клавиатуры. Порядок задаёт только человек.
// Проект: нажали на ⠿ и повели (сдвиг больше 5 px) — заголовок поднимается карточкой ровно с того места, где схватили; строки схваченного проекта сворачиваются,
// на его месте — гнездо. DOM во время перетаскивания не переставляется: соседи только сдвигаются transform по раскладке-модели, поэтому без рывков. «Без проекта» стоит
// последним и не двигается. Нажали и отпустили на ⠿ — меню проекта.
// Строка: мышь — нажать и повести, палец — удержать (начало жеста — startPress, как у фильтров). Строка поднимается копией, линия показывает место; родитель едет блоком
// с дочерними. На свёрнутый проект можно бросать: строка встаёт в его конец. Плоский список и группы по машинам порядок только читают: api.rowsMove() — false.
// У края — прокрутка, быстрее ближе к краю. Escape — отмена. Захват указателя и карточка — у постоянного элемента списка: перерисовки на время жеста только
// запоминаются (класс reordering), закрытие экрана — отмена.
import { startPress, type Press } from "./gesture.ts";

const SLOP = 5;
const EDGE = 52;
const SPEED = 1400; // px/с у края
const EASE = "cubic-bezier(0,0,.58,1)";

export const calm = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const dur = () => (calm() ? 0 : 220);

export type ProjectsApi = {
  /** постоянный элемент списка: не перерисовывается */
  root: HTMLElement;
  /** новый порядок проектов: name перед before; before нет — в конец */
  place(name: string, before: string | null): void;
  /** нажатие на ⠿ без перетаскивания и Enter на ней */
  menu(name: string): void;
  /** можно ли сейчас переставлять строки */
  rowsMove(): boolean;
  /** поставить блок строк в проект перед before; before нет — в конец; shown — показанные строки этого проекта */
  placeRows(block: string[], project: string, before: string | null, shown: string[]): void;
  /** перерисовать список сейчас */
  redraw(): void;
};

type Item = { el: HTMLElement; top: number; h: number };
type Tail = { el: HTMLElement; top: number; h: number; gap: number };
type Lay = { pos: Map<HTMLElement, number>; end: number };
type Drag = {
  name: string; lst: HTMLElement; sec: HTMLElement; sc: HTMLElement; pid: number; x0: number; y0: number; y: number; active: boolean;
  grab: number; cy0: number; cardY: number; lift: number; items: Item[]; tail: Tail[]; top: number; hd: number; yTop: number;
  k: number; k0: number; card: HTMLElement; L: Lay; sy: number; expanded: boolean; raf: number; ts: number; acc: number; upOk: boolean; downOk: boolean;
};

const scrollerOf = (lst: Element) => lst.closest<HTMLElement>(".bd-body")!;
const secsOf = (lst: Element) => [...lst.querySelectorAll<HTMLElement>(':scope > .pjs:not([data-proj="~"])')];
const keyOf = (el: HTMLElement) => (el.classList.contains("pjs") ? "p:" + el.dataset.proj : el.className);
const setY = (el: HTMLElement, dy: number) => void (el.style.transform = dy ? `translateY(${dy}px)` : "");
function viewOf(sc: HTMLElement) {
  const r = sc.getBoundingClientRect();
  return { top: Math.max(r.top, 0), bottom: Math.min(r.bottom, window.innerHeight) };
}
const screenOf = (lst: HTMLElement) => new Map([...lst.children].map((el) => [keyOf(el as HTMLElement), el.getBoundingClientRect().top]));

/** Перестановка проектов в списке; снять — signal. */
export function attachProjectDrag(api: ProjectsApi, signal: AbortSignal) {
  const root = api.root;
  let drag: Drag | null = null;
  let landing: (() => void) | null = null;
  const on = { signal };

  const lstOf = () => root.querySelector<HTMLElement>(".lst");

  /** после перерисовки: всё, что сдвинулось, доезжает со старого места; open — проект, который разворачивается из заголовка */
  function flipAfter(before: Map<string, number>, open: string | null) {
    const lst = lstOf();
    if (!lst || calm()) return;
    const sec = open ? secsOf(lst).find((s) => s.dataset.proj === open) : undefined;
    const hd = sec ? sec.querySelector<HTMLElement>(".pj")!.offsetHeight : 0;
    const fold = sec ? sec.offsetHeight - hd : 0;
    for (const el of lst.children as unknown as HTMLElement[]) {
      const b = before.get(keyOf(el));
      if (b == null) continue;
      const dy = Math.round(b - el.getBoundingClientRect().top);
      const kf: Keyframe[] = [{ transform: `translateY(${dy}px)` }, { transform: "none" }];
      if (el === sec && fold > 0) {
        kf[0].clipPath = `inset(0 0 ${fold}px 0)`;
        kf[1].clipPath = "inset(0 0 0 0)";
      } else if (!dy) continue;
      el.animate(kf, { duration: dur(), easing: EASE });
    }
    stickWhile(dur() + 80);
  }

  /** раскладка-модель: где каждый стоит при гнезде на месте k */
  function layout(d: Drag): Lay {
    const slot = { el: d.sec, h: d.hd };
    const pos = new Map<HTMLElement, number>();
    let y = d.yTop;
    for (const it of [...d.items.slice(0, d.k), slot, ...d.items.slice(d.k)]) {
      pos.set(it.el, y);
      y += it.h;
    }
    for (const t of d.tail) {
      y += t.gap;
      pos.set(t.el, y);
      y += t.h;
    }
    return { pos, end: y };
  }

  /** раскладку — на экран: соседи едут transition'ом, гнездо встаёт сразу и проявляется */
  function apply(d: Drag) {
    const L = (d.L = layout(d));
    for (const it of [...d.items, ...d.tail]) setY(it.el, L.pos.get(it.el)! - it.top);
    const sy = L.pos.get(d.sec)! - d.top;
    if (sy !== d.sy) {
      d.sy = sy;
      setY(d.sec, sy);
      if (!calm()) d.sec.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, pseudoElement: "::after" });
    }
  }

  /** место — по серединам соседей */
  function hit(d: Drag) {
    const c = d.cardY + d.hd / 2 - d.lst.getBoundingClientRect().top;
    let k = 0;
    for (const it of d.items) if (d.L.pos.get(it.el)! + it.h / 2 < c) k++;
    if (k !== d.k) {
      d.k = k;
      apply(d);
    }
  }

  /** карточка — за пальцем с места хвата, в границах видимой части списка */
  function follow(d: Drag) {
    const v = viewOf(d.sc);
    const rr = root.getBoundingClientRect();
    d.cardY = Math.min(Math.max(d.y - d.grab, Math.min(v.top, d.cy0)), Math.max(v.bottom - d.hd, d.cy0));
    d.card.style.translate = `0px ${d.cardY + d.lift - rr.top - root.clientTop}px`;
    hit(d);
    stickFix(d.lst);
  }

  /** sticky считает место заголовка без transform раздела: у сдвинутого раздела прилипший заголовок — снова у края */
  function stickFix(lst: HTMLElement) {
    const V = scrollerOf(lst).getBoundingClientRect().top;
    for (const s of lst.querySelectorAll<HTMLElement>(":scope > .pjs:not(.dnd-slot)")) {
      const hdr = s.querySelector<HTMLElement>(".pj")!;
      const cur = Number(hdr.dataset.dy) || 0;
      const r = s.getBoundingClientRect();
      let dy = 0;
      if (r.top < V + 80 && r.bottom > V) {
        const want = Math.max(r.top, Math.min(V, r.bottom - hdr.offsetHeight));
        dy = Math.round(want - (hdr.getBoundingClientRect().top - cur));
      }
      if (dy !== cur) {
        hdr.style.translate = dy ? `0px ${dy}px` : "";
        if (dy) hdr.dataset.dy = String(dy);
        else delete hdr.dataset.dy;
      }
    }
  }
  function stickWhile(ms: number) {
    const t0 = performance.now();
    const step = (now: number) => {
      const l = lstOf();
      if (!l) return;
      stickFix(l);
      if (now - t0 < ms) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function begin(d: Drag) {
    const { lst, sec, sc } = d;
    const hdr = sec.querySelector<HTMLElement>(".pj")!;
    const hb = hdr.getBoundingClientRect();
    d.grab = d.y0 - hb.top;
    d.cy0 = hb.top;
    const full = sec.offsetHeight;
    const hh = hdr.offsetHeight;
    const shift = hb.top - sec.getBoundingClientRect().top; // сколько проекта ушло за верхний край под прилипший заголовок
    const before = new Map([...lst.children].map((el) => [el as HTMLElement, el.getBoundingClientRect().top]));
    lst.style.minHeight = lst.offsetHeight + "px"; // сворачивание не обрезает прокрутку — список не прыгает
    root.classList.add("reordering");
    lst.classList.add("dnd-on");
    sec.classList.add("dnd-slot");
    sec.style.height = hh + "px";
    if (shift) sec.querySelectorAll<HTMLElement>(":scope > .bd-row, :scope > .mgrp").forEach((r) => (r.style.transform = `translateY(${-shift}px)`));
    for (const el of lst.children as unknown as HTMLElement[]) {
      el.style.transition = "none";
      el.style.transform = "";
    }
    const secs = secsOf(lst);
    d.items = secs.filter((s) => s !== sec).map((el) => ({ el, top: el.offsetTop, h: el.offsetHeight }));
    d.top = sec.offsetTop;
    d.hd = hh;
    d.yTop = secs[0].offsetTop;
    const last = secs[secs.length - 1];
    let bottom = last.offsetTop + last.offsetHeight;
    d.tail = ([...lst.children] as HTMLElement[])
      .filter((el) => !secs.includes(el))
      .map((el) => {
        const t = { el, top: el.offsetTop, h: el.offsetHeight, gap: el.offsetTop - bottom };
        bottom = t.top + t.h;
        return t;
      });
    d.k0 = d.k = d.items.filter((i) => i.top < d.top).length;
    // карточка: копия заголовка, ровные поля; содержимое — точно там же, где было
    const card = (d.card = hdr.cloneNode(true) as HTMLElement);
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
    d.lift = parseFloat(getComputedStyle(hdr).paddingTop) - parseFloat(getComputedStyle(card).paddingTop) || 0;
    d.expanded = hdr.querySelector(".pj-t")!.getAttribute("aria-expanded") === "true";
    d.sy = NaN;
    d.L = layout(d);
    // гнездо — ровно там, где был заголовок (и прилипший тоже)
    sc.scrollTop += lst.getBoundingClientRect().top + d.L.pos.get(sec)! - hb.top;
    const lt = lst.getBoundingClientRect().top;
    for (const it of [...d.items, ...d.tail]) setY(it.el, before.get(it.el)! - (lt + it.top));
    void lst.offsetHeight; // зафиксировать старые места
    for (const el of lst.children as unknown as HTMLElement[]) el.style.transition = "";
    d.sy = d.L.pos.get(sec)! - d.top;
    setY(sec, d.sy);
    // свёртка: строки стираются снизу вверх вместе со следующим проектом, который едет на их место
    const rest = full - hh - shift;
    if (rest > 0 && !calm()) sec.animate([{ clipPath: `inset(0 -9px ${-rest}px -9px)` }, { clipPath: "inset(0 -9px 0 -9px)" }], { duration: dur(), easing: EASE }).onfinish = () => sec.classList.add("dnd-folded");
    else sec.classList.add("dnd-folded");
    d.active = true;
    follow(d);
    apply(d);
    requestAnimationFrame(() => {
      card.classList.add("up");
      card.querySelector(".pj-t")?.setAttribute("aria-expanded", "false");
    });
    d.ts = 0;
    d.acc = 0;
    const tick = (ts: number) => {
      if (drag !== d) return;
      const dt = d.ts ? Math.min(50, ts - d.ts) : 0;
      d.ts = ts;
      // край включается, только когда к нему повели: схватили у края — список не убегает
      const v = viewOf(sc);
      const up = v.top + EDGE - d.y;
      const down = d.y - (v.bottom - EDGE);
      if (up <= 0 || d.y < d.y0 - 12) d.upOk = true;
      if (down <= 0 || d.y > d.y0 + 12) d.downOk = true;
      const f = (x: number) => SPEED * Math.min(1.7, x / EDGE) ** 2;
      let s = up > 0 && d.upOk ? -f(up) : down > 0 && d.downOk ? f(down) : 0;
      if (s > 0 && lst.getBoundingClientRect().top + d.L.end + 14 <= v.bottom) s = 0; // ниже последнего проекта не едем
      if (s) {
        d.acc += (s * dt) / 1000;
        const step = Math.trunc(d.acc);
        if (step) {
          const was = sc.scrollTop;
          sc.scrollTop = was + step;
          d.acc -= step;
          if (sc.scrollTop === was) d.acc = 0;
        }
      } else d.acc = 0;
      follow(d);
      d.raf = requestAnimationFrame(tick);
    };
    d.raf = requestAnimationFrame(tick);
  }

  /** конец: ok — сохранить показанный порядок, иначе вернуть всё на место; карточка садится в гнездо */
  function end(ok: boolean) {
    const d = drag!;
    drag = null;
    try {
      root.releasePointerCapture(d.pid);
    } catch {
      /* захват уже снят */
    }
    if (!d.active) {
      if (ok) api.menu(d.name);
      return;
    }
    cancelAnimationFrame(d.raf);
    if (!ok) {
      d.k = d.k0;
      apply(d);
    }
    const moved = d.k !== d.k0;
    const nextId = d.items[d.k]?.el.dataset.proj ?? null;
    // посадка: в гнездо; гнездо за краем — карточка уходит к краю и тает
    const v = viewOf(d.sc);
    const rr = root.getBoundingClientRect();
    const y = d.lst.getBoundingClientRect().top + d.L.pos.get(d.sec)!;
    const off = y < v.top - d.hd / 2 || y > v.bottom - d.hd / 2;
    const cy = Math.min(Math.max(y, v.top - d.hd), v.bottom);
    d.card.classList.add("land");
    d.card.classList.remove("up");
    if (off) d.card.style.opacity = "0";
    d.card.style.translate = `0px ${cy + d.lift - rr.top - root.clientTop}px`;
    d.card.querySelector(".pj-t")?.setAttribute("aria-expanded", String(d.expanded));
    stickWhile(dur());
    const done = () => {
      if (landing !== done) return;
      landing = null;
      const before = screenOf(d.lst);
      d.card.remove();
      root.classList.remove("reordering");
      if (ok && moved) api.place(d.name, nextId);
      api.redraw();
      flipAfter(before, d.expanded ? d.name : null);
    };
    landing = done;
    if (dur()) setTimeout(done, dur() + 20);
    else done();
  }

  root.addEventListener(
    "pointerdown",
    (e) => {
      if (landing) {
        landing(); // прошлая посадка — доводится сразу
        return;
      }
      const g = (e.target as Element).closest<HTMLElement>(".grip");
      if (!g) return void pressRow(e);
      if (drag || row || !e.isPrimary || e.button !== 0) return;
      const sec = g.closest<HTMLElement>(".pjs");
      const lst = sec?.parentElement;
      if (!sec || !lst) return;
      e.preventDefault(); // без выделения текста и фокуса мышью
      try {
        root.setPointerCapture(e.pointerId);
      } catch {
        /* указатель уже ушёл */
      }
      drag = { name: g.dataset.proj!, lst, sec, sc: scrollerOf(lst), pid: e.pointerId, x0: e.clientX, y0: e.clientY, y: e.clientY, active: false, upOk: false, downOk: false } as Drag;
    },
    on,
  );
  root.addEventListener(
    "pointermove",
    (e) => {
      const d = drag;
      if (!d || e.pointerId !== d.pid) return;
      d.y = e.clientY;
      if (!d.active) {
        if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < SLOP) return;
        begin(d);
      }
      follow(d);
    },
    on,
  );
  root.addEventListener("pointerup", (e) => void (drag && e.pointerId === drag.pid && end(true)), on);
  root.addEventListener("pointercancel", (e) => void (drag && e.pointerId === drag.pid && end(false)), on);
  root.addEventListener("lostpointercapture", (e) => void (drag && e.pointerId === drag.pid && end(false)), on);
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
      const g = (e.target as Element).closest?.<HTMLElement>(".grip");
      if (!g || drag) return;
      const name = g.dataset.proj!;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        return api.menu(name);
      }
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      if (landing) {
        landing();
        return;
      }
      const lst = g.closest<HTMLElement>(".lst")!;
      const ids = secsOf(lst).map((s) => s.dataset.proj!);
      const i = ids.indexOf(name);
      if ((e.key === "ArrowUp" && i === 0) || (e.key === "ArrowDown" && i === ids.length - 1)) return;
      const before = screenOf(lst);
      api.place(name, e.key === "ArrowUp" ? ids[i - 1] : (ids[i + 2] ?? null));
      api.redraw();
      const again = root.querySelector<HTMLElement>(`.grip[data-proj=${JSON.stringify(name)}]`);
      if (!again) return;
      again.focus({ preventScroll: true });
      const sc = scrollerOf(again);
      const v = viewOf(sc);
      const r = again.getBoundingClientRect();
      if (r.top < v.top || r.bottom > v.bottom) again.scrollIntoView({ block: "center" });
      else flipAfter(before, null);
    },
    on,
  );

  // ───── строка ─────
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

  function pressRow(e: PointerEvent) {
    const el = (e.target as Element).closest<HTMLElement>(".bd-row");
    if (!el || drag || row || !e.isPrimary || e.button !== 0 || !api.rowsMove()) return;
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
      const up = v.top + EDGE - d.y;
      const down = d.y - (v.bottom - EDGE);
      const f = (x: number) => SPEED * Math.min(1.7, x / EDGE) ** 2;
      const speed = up > 0 ? -f(up) : down > 0 ? f(down) : 0;
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
    const swallow = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
    };
    root.addEventListener("click", swallow, { capture: true, once: true, signal });
    setTimeout(() => root.removeEventListener("click", swallow, { capture: true }), 50);
    d.ghost.remove();
    d.line.remove();
    d.lst.querySelector(".pj.dnd-into")?.classList.remove("dnd-into");
    for (const x of d.block) x.classList.remove("dnd-row-out");
    root.classList.remove("reordering");
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

  /** закрытие экрана посреди жеста — отмена */
  signal.addEventListener("abort", () => {
    if (drag) cancelAnimationFrame(drag.raf);
    drag = null;
    landing = null;
    if (row) {
      row.press.cancel();
      cancelAnimationFrame(row.raf);
    }
    row = null;
  });
}
