// Жесты «Работы» поверх готовой разметки: один трекер указателя, сортировка соседей по оси (проекты и чипы), бросок строки.
// Жест не трогает React: двигает элементы стилем и в конце зовёт ту же правку, что и клавиатура.
const HOLD_MS = 300;
const MOUSE_SLOP = 5;
const TOUCH_SLOP = 8;
const LAND_MS = 200;
const EDGE = 40;
const STEP = 12;

type Point = { x: number; y: number };
type Gesture = { move(p: Point): void; drop(): void; cancel(): void };
type Down = { pointerType: string; clientX: number; clientY: number; button: number };

/** Палец ведёт поднятое: прокрутку останавливает этот обработчик, он должен стоять до касания. */
let lifted = false;
export function holdTouch(el: HTMLElement): () => void {
  const stop = (e: TouchEvent) => lifted && e.preventDefault();
  el.addEventListener("touchmove", stop, { passive: false });
  return () => el.removeEventListener("touchmove", stop);
}

/** Клик, который браузер шлёт после жеста, — не нажатие. */
function swallowClick() {
  const eat = (e: Event) => e.stopPropagation();
  window.addEventListener("click", eat, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", eat, { capture: true }), LAND_MS);
}

/** Следить за указателем: мышь — с порога, палец — с удержания (hold) или с порога; ведение раньше удержания — прокрутка браузера. */
export function track(down: Down, hold: boolean, begin: (from: Point) => Gesture) {
  if (down.button !== 0) return;
  const from = { x: down.clientX, y: down.clientY };
  const finger = down.pointerType !== "mouse";
  const waits = finger && hold;
  let gesture: Gesture | null = null;
  let spent = false;
  const start = () => {
    window.getSelection()?.removeAllRanges();
    lifted = true;
    gesture = begin(from);
  };
  const timer = waits ? setTimeout(start, HOLD_MS) : undefined;
  // удержание пальцем — это жест, а не меню браузера
  const noMenu = (e: Event) => e.preventDefault();
  const finish = (act?: "drop" | "cancel") => {
    clearTimeout(timer);
    lifted = false;
    if (gesture && act) gesture[act]();
    gesture = null;
    spent = spent || !!act;
  };
  const off = () => {
    finish();
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("contextmenu", noMenu);
  };
  function onMove(e: PointerEvent) {
    const p = { x: e.clientX, y: e.clientY };
    if (gesture) return gesture.move(p);
    if (spent) return;
    const far = Math.hypot(p.x - from.x, p.y - from.y) > (finger ? TOUCH_SLOP : MOUSE_SLOP);
    if (far && waits) off();
    else if (far) {
      start();
      gesture!.move(p);
    }
  }
  function onUp() {
    if (gesture || spent) swallowClick();
    finish("drop");
    off();
  }
  function onCancel() {
    finish("cancel");
    off();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && gesture) finish("cancel");
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey);
  if (waits) window.addEventListener("contextmenu", noMenu);
}

type Axis = "x" | "y";

/** У края прокрутки список едет сам, пока идёт жест; tick — пересчитать место. */
function edgeScroll(scroller: HTMLElement, axis: Axis, at: () => number, tick: () => void): () => void {
  const prop = axis === "y" ? "scrollTop" : "scrollLeft";
  let frame = requestAnimationFrame(function step() {
    const box = scroller.getBoundingClientRect();
    const [start, end] = axis === "y" ? [box.top, box.bottom] : [box.left, box.right];
    const by = at() > end - EDGE ? STEP : at() < start + EDGE ? -STEP : 0;
    if (by) {
      scroller[prop] += by;
      tick();
    }
    frame = requestAnimationFrame(step);
  });
  return () => cancelAnimationFrame(frame);
}

/** Поднятая копия элемента: лежит в host и едет за указателем. */
function lift(grabbed: HTMLElement, host: HTMLElement, classes: string[]) {
  const box = grabbed.getBoundingClientRect();
  const base = host.getBoundingClientRect();
  const card = grabbed.cloneNode(true) as HTMLElement;
  card.classList.add(...classes);
  // без имён, по которым её нашли бы вместо настоящего, и вне фокуса
  for (const x of [card, ...card.querySelectorAll("*")]) for (const name of ["data-proj", "data-fid", "data-callsign", "role", "tabindex"]) x.removeAttribute(name);
  card.querySelector(".pj-t")?.setAttribute("aria-expanded", "false");
  card.setAttribute("aria-hidden", "true");
  card.style.width = `${box.width}px`;
  host.append(card);
  // у поднятой копии свои отступы: содержимое остаётся там, где схватили
  const inset = parseFloat(getComputedStyle(grabbed).paddingTop) - parseFloat(getComputedStyle(card).paddingTop);
  const place = (dx: number, dy: number) => void (card.style.translate = `${box.left - base.left + dx}px ${box.top - base.top + dy + inset}px`);
  place(0, 0);
  return { card, box, place };
}

export type SortOptions = {
  host: HTMLElement;
  list: HTMLElement;
  scroller: HTMLElement;
  items: HTMLElement[];
  item: HTMLElement;
  /** что поднимается: сам элемент или его заголовок */
  grabbed: HTMLElement;
  axis: Axis;
  look: { on: string; slot: string[]; card: string; up: string; land: string };
  /** брошен: на этом месте среди остальных */
  done(index: number): void;
};

/** Перестановка в ряду: соседи расступаются, на месте остаётся пустое гнездо. */
export function sorting(o: SortOptions, from: Point): Gesture {
  const start = o.axis === "y" ? "top" : "left";
  const dim = o.axis === "y" ? "height" : "width";
  const scrollOf = () => (o.axis === "y" ? o.scroller.scrollTop : o.scroller.scrollLeft);
  const at = o.items.indexOf(o.item);
  const { card, box, place } = lift(o.grabbed, o.host, [o.look.card, o.look.up]);
  o.host.classList.add("reordering");
  o.list.classList.add(o.look.on);
  o.item.classList.add(...o.look.slot);
  const boxes = o.items.map((el) => el.getBoundingClientRect());
  const gap = boxes.length > 1 ? Math.max(boxes[1][start] - boxes[0][start] - boxes[0][dim], 0) : 0;
  const size = boxes[at][dim] + gap;
  const others = o.items.flatMap((el, i) => (i === at ? [] : [{ el, mid: boxes[i][start] + boxes[i][dim] / 2, size: boxes[i][dim] + gap }]));
  const scroll0 = scrollOf();
  const shift = (el: HTMLElement, by: number) => void (el.style.transform = by ? (o.axis === "y" ? `translateY(${by}px)` : `translateX(${by}px)`) : "");
  let now = from;
  let to = at;

  function layout() {
    const center = (o.axis === "y" ? now.y - from.y : now.x - from.x) + box[start] + box[dim] / 2;
    const scrolled = scrollOf() - scroll0;
    to = others.filter((x) => x.mid - scrolled < center).length;
    others.forEach((x, j) => shift(x.el, j >= to && j < at ? size : j < to && j >= at ? -size : 0));
    shift(o.item, others.slice(Math.min(to, at), Math.max(to, at)).reduce((n, x) => n + x.size, 0) * Math.sign(to - at));
  }
  const stopScroll = edgeScroll(o.scroller, o.axis, () => (o.axis === "y" ? now.y : now.x), layout);

  function land(index: number, commit: boolean) {
    stopScroll();
    if (!commit) {
      others.forEach((x) => shift(x.el, 0));
      shift(o.item, 0);
    }
    const slot = o.grabbed.getBoundingClientRect();
    card.classList.remove(o.look.up);
    card.classList.add(o.look.land);
    place(slot.left - box.left, slot.top - box.top);
    setTimeout(() => {
      card.remove();
      for (const el of o.items) el.style.transform = "";
      o.host.classList.remove("reordering");
      o.list.classList.remove(o.look.on);
      o.item.classList.remove(...o.look.slot);
      if (commit && index !== at) o.done(index);
    }, LAND_MS);
  }

  return {
    move(p) {
      now = p;
      place(p.x - from.x, p.y - from.y);
      layout();
    },
    drop: () => land(to, true),
    cancel: () => land(at, false),
  };
}

export type RowOptions = {
  host: HTMLElement;
  scroller: HTMLElement;
  row: HTMLElement;
  /** строки блока: родитель и потомки */
  block: string[];
  /** брошена: блок в порядке экрана, проект, перед какой строкой, строки проекта на экране */
  done(block: string[], project: string, before: string | null, rows: string[]): void;
};

/** Бросок строки: линия показывает место, свёрнутый проект принимает в конец. */
export function rowDrag(o: RowOptions, from: Point): Gesture {
  const { card, place } = lift(o.row, o.host, ["dnd-row-card"]);
  const base = o.host.getBoundingClientRect();
  const line = document.createElement("div");
  line.className = "dnd-row-line";
  line.hidden = true;
  o.host.append(line);
  o.host.classList.add("reordering");
  const of = (el: HTMLElement) => el.dataset.callsign!;
  const rowsIn = (section: Element) => [...section.querySelectorAll<HTMLElement>(":scope > .bd-row")];
  const stay = (rows: HTMLElement[]) => rows.filter((r) => !o.block.includes(of(r)));
  for (const r of o.host.querySelectorAll<HTMLElement>(".bd-row")) if (o.block.includes(of(r))) r.classList.add("dnd-row-out");
  let now = from;
  let target: { project: string; before: string | null; rows: string[] } | null = null;
  let into: Element | null = null;

  function mark(el: HTMLElement | null, y: number) {
    line.hidden = !el;
    if (!el) return;
    const box = el.getBoundingClientRect();
    line.style.cssText = `left:${box.left - base.left}px;width:${box.width}px;top:${y - base.top - 1}px`;
  }

  function locate() {
    const sections = [...o.host.querySelectorAll<HTMLElement>(".lst > .pjs")];
    const section = sections.find((s) => now.y < s.getBoundingClientRect().bottom) ?? sections.at(-1);
    into?.classList.remove("dnd-into");
    into = null;
    if (!section) return;
    const all = rowsIn(section);
    const rows = stay(all);
    const project = section.dataset.proj!;
    const head = section.querySelector<HTMLElement>(".pj")!;
    const next = rows.find((r) => {
      const box = r.getBoundingClientRect();
      return now.y < box.top + box.height / 2;
    });
    // заголовок проекта — бросок в него
    const onHead = now.y < head.getBoundingClientRect().bottom;
    target = { project, before: next && !onHead ? of(next) : null, rows: all.map(of) };
    if (onHead || !rows.length) {
      into = head;
      into.classList.add("dnd-into");
      return mark(null, 0);
    }
    const end = rows.at(-1)!.getBoundingClientRect().bottom;
    mark(next ?? rows.at(-1)!, next ? next.getBoundingClientRect().top : end);
  }
  const stopScroll = edgeScroll(o.scroller, "y", () => now.y, locate);

  function clean() {
    stopScroll();
    card.remove();
    line.remove();
    into?.classList.remove("dnd-into");
    o.host.classList.remove("reordering");
    for (const r of o.host.querySelectorAll(".dnd-row-out")) r.classList.remove("dnd-row-out");
  }

  return {
    move(p) {
      now = p;
      place(p.x - from.x, p.y - from.y);
      locate();
    },
    drop() {
      const shown = [...o.host.querySelectorAll<HTMLElement>(".lst .bd-row")].map(of).filter((c) => o.block.includes(c));
      clean();
      if (target) o.done([...shown, ...o.block.filter((c) => !shown.includes(c))], target.project, target.before, target.rows);
    },
    cancel: clean,
  };
}
