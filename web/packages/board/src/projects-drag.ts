// Перестановка проектов: мышь и палец одним кодом (pointer), стрелки на ручке — с клавиатуры.
// Нажали на ⠿ и повели (сдвиг больше 5 px) — заголовок поднимается карточкой ровно с того места, где схватили; строки схваченного
// проекта сворачиваются, на его месте — гнездо. DOM во время перетаскивания не переставляется: соседи только сдвигаются transform
// по раскладке-модели, поэтому без рывков. Гнездо среди закреплённых и сразу под ними — закрепить на этом месте; ниже — проект
// встаёт туда, где окажется по правилу. У края — прокрутка, быстрее ближе к краю. Escape — отмена. Захват указателя и карточка —
// у постоянного элемента списка: перерисовки на время жеста только запоминаются (класс reordering), закрытие экрана — отмена.
const SLOP = 5;
const EDGE = 52;
const SPEED = 1400; // px/с у края
const EASE = "cubic-bezier(0,0,.58,1)";

export const calm = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const dur = () => (calm() ? 0 : 220);

export type ProjectsApi = {
  /** постоянный элемент списка: не перерисовывается */
  root: HTMLElement;
  /** номер проекта среди незакреплённых по правилу, если его открепить */
  ruleIndex(name: string): number;
  /** новый порядок: name среди видимых закреплённых vis на месте k; k null — открепить */
  place(name: string, vis: string[], k: number | null): void;
  /** перерисовать список сейчас */
  redraw(): void;
};

type Item = { el: HTMLElement; pinned: boolean; top: number; h: number };
type Tail = { el: HTMLElement; top: number; h: number; gap: number };
type Lay = { pos: Map<HTMLElement, number>; sepY: number | null; secEnd: number; end: number };
type Drag = {
  name: string; lst: HTMLElement; sec: HTMLElement; sc: HTMLElement; pid: number; x0: number; y0: number; y: number; active: boolean;
  grab: number; cy0: number; cardY: number; lift: number; items: Item[]; tail: Tail[]; top: number; hd: number; yTop: number; sepH: number; sepM: number; P: number; r: number;
  mode: "pin" | "rule"; k: number | null; mode0: "pin" | "rule"; k0: number | null; sep: HTMLElement; card: HTMLElement; L: Lay; sy: number; expanded: boolean; raf: number; ts: number; acc: number; upOk: boolean; downOk: boolean;
};

const scrollerOf = (lst: Element) => lst.closest<HTMLElement>(".bd-body")!;
const secsOf = (lst: Element) => [...lst.querySelectorAll<HTMLElement>(":scope > .pjs")];
const keyOf = (el: HTMLElement) => (el.classList.contains("pjs") ? "p:" + el.dataset.proj : el.classList.contains("pin-sep") ? "sep" : el.className);
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

  /** раскладка-модель: где каждый стоит при гнезде в зоне mode на месте k */
  function layout(d: Drag): Lay {
    const pins = d.items.filter((i) => i.pinned);
    const rest = d.items.filter((i) => !i.pinned);
    const slot = { el: d.sec, h: d.hd };
    const a = d.mode === "pin" ? [...pins.slice(0, d.k ?? 0), slot, ...pins.slice(d.k ?? 0)] : pins;
    const b = d.mode === "pin" ? rest : [...rest.slice(0, d.r), slot, ...rest.slice(d.r)];
    const pos = new Map<HTMLElement, number>();
    let y = d.yTop;
    let sepY: number | null = null;
    for (const it of a) {
      pos.set(it.el, y);
      y += it.h;
    }
    if (a.length && b.length) {
      sepY = y;
      y += d.sepH;
    }
    for (const it of b) {
      pos.set(it.el, y);
      y += it.h;
    }
    const secEnd = y;
    for (const t of d.tail) {
      y += t.gap;
      pos.set(t.el, y);
      y += t.h;
    }
    return { pos, sepY, secEnd, end: y };
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
    d.sec.classList.toggle("dnd-pin", d.mode === "pin");
    d.card.classList.toggle("dnd-pin", d.mode === "pin");
    if (L.sepY !== null) {
      d.sep.style.transform = `translateY(${L.sepY}px)`;
      d.sep.style.opacity = "";
    } else d.sep.style.opacity = "0";
  }

  /** зона — по черте: центр карточки перешёл черту — зона другая; место среди закреплённых — по серединам соседей */
  function hit(d: Drag) {
    const c = d.cardY + d.hd / 2 - d.lst.getBoundingClientRect().top;
    const L = d.L;
    const line = L.sepY !== null ? L.sepY + d.sepH / 2 : d.P === d.items.length ? L.secEnd - 8 : d.yTop + d.hd;
    const mode = c < line ? "pin" : "rule";
    let k: number | null = null;
    if (mode === "pin") {
      k = 0;
      for (const it of d.items) if (it.pinned && L.pos.get(it.el)! + it.h / 2 < c) k++;
    }
    if (mode !== d.mode || k !== d.k) {
      d.mode = mode;
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
    let sep = lst.querySelector<HTMLElement>(":scope > .pin-sep");
    const sepWas = sep ? (before.get(sep) ?? null) : null;
    if (!sep) {
      sep = document.createElement("div");
      sep.className = "pin-sep";
      sep.setAttribute("aria-hidden", "true");
      lst.appendChild(sep);
    }
    d.sep = sep;
    for (const el of lst.children as unknown as HTMLElement[]) {
      el.style.transition = "none";
      el.style.transform = "";
    }
    const secs = secsOf(lst);
    d.items = secs.filter((s) => s !== sec).map((el) => ({ el, pinned: el.classList.contains("pinned"), top: el.offsetTop, h: el.offsetHeight }));
    d.top = sec.offsetTop;
    d.hd = hh;
    d.yTop = secs[0].offsetTop;
    const sm = getComputedStyle(sep);
    d.sepM = parseFloat(sm.marginTop) || 0;
    d.sepH = d.sepM + (parseFloat(sm.marginBottom) || 0) + sep.offsetHeight;
    const last = secs[secs.length - 1];
    let bottom = last.offsetTop + last.offsetHeight;
    d.tail = ([...lst.children] as HTMLElement[])
      .filter((el) => !el.matches(".pjs, .pin-sep"))
      .map((el) => {
        const t = { el, top: el.offsetTop, h: el.offsetHeight, gap: el.offsetTop - bottom };
        bottom = t.top + t.h;
        return t;
      });
    d.P = d.items.filter((i) => i.pinned).length;
    d.r = api.ruleIndex(d.name);
    const pinned = sec.classList.contains("pinned");
    d.mode0 = d.mode = pinned ? "pin" : "rule";
    d.k0 = d.k = pinned ? d.items.filter((i) => i.pinned && i.top < d.top).length : null;
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
    if (sepWas !== null) sep.style.transform = `translateY(${sepWas - lt - d.sepM}px)`;
    else {
      sep.style.opacity = "0";
      if (d.L.sepY !== null) sep.style.transform = `translateY(${d.L.sepY}px)`;
    }
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
    if (!d.active) return;
    cancelAnimationFrame(d.raf);
    if (!ok) {
      d.mode = d.mode0;
      d.k = d.k0;
      apply(d);
    }
    const vis = d.items.filter((i) => i.pinned).map((i) => i.el.dataset.proj!);
    const k = d.mode === "pin" ? d.k : null;
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
      if (ok) api.place(d.name, vis, k);
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
      if (!g || drag || !e.isPrimary || e.button !== 0) return;
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
  // стрелки на ручке. Вверх: незакреплённый — последним закреплённым, закреплённый — на одно выше; вниз: на одно ниже, последний — открепляется
  root.addEventListener(
    "keydown",
    (e) => {
      const g = (e.target as Element).closest?.<HTMLElement>(".grip");
      if (!g || drag || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      e.preventDefault();
      if (landing) {
        landing();
        return;
      }
      const lst = g.closest<HTMLElement>(".lst")!;
      const name = g.dataset.proj!;
      const vis = secsOf(lst).filter((s) => s.classList.contains("pinned")).map((s) => s.dataset.proj!);
      const i = vis.indexOf(name);
      if ((e.key === "ArrowUp" && i === 0) || (e.key === "ArrowDown" && i < 0)) return;
      const k = e.key === "ArrowUp" ? (i < 0 ? vis.length : i - 1) : i + 1 >= vis.length ? null : i + 1;
      const before = screenOf(lst);
      api.place(name, vis, k);
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
  /** закрытие экрана посреди жеста — отмена */
  signal.addEventListener("abort", () => {
    if (drag) cancelAnimationFrame(drag.raf);
    drag = null;
    landing = null;
  });
}
