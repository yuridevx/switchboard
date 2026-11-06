// Жест указателя на всю страницу: мышь и ручка — с порога, палец — с удержания; у края прокрутка едет сама.
// Жест не трогает React: двигает элементы стилем и в конце зовёт ту же правку, что и клавиатура.
const HOLD_MS = 300;
const MOUSE_SLOP = 5;
const TOUCH_SLOP = 8;
const EDGE = 40;
const STEP = 12;

export type Point = { x: number; y: number };
export type Gesture = { move(p: Point): void; drop(): void; cancel(): void };
type Down = { pointerId: number; pointerType: string; clientX: number; clientY: number; button: number };

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
  setTimeout(() => window.removeEventListener("click", eat, { capture: true }), 0);
}

/** Следить за указателем: мышь и ручка — с порога, палец — с удержания (hold) или с порога; ведение раньше удержания — прокрутка браузера. Второй палец жест не трогает. */
export function track(down: Down, hold: boolean, begin: (from: Point) => Gesture) {
  if (down.button !== 0) return;
  const from = { x: down.clientX, y: down.clientY };
  const finger = down.pointerType === "touch";
  const waits = finger && hold;
  const other = (e: PointerEvent) => e.pointerId !== down.pointerId;
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
    if (other(e)) return;
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
  function onUp(e: PointerEvent) {
    if (other(e)) return;
    if (gesture || spent) swallowClick();
    finish("drop");
    off();
  }
  function onCancel(e: PointerEvent) {
    if (other(e)) return;
    finish("cancel");
    off();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") finish("cancel");
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey);
  if (waits) window.addEventListener("contextmenu", noMenu);
}

export type Axis = "x" | "y";

/** У края прокрутки список едет сам, пока идёт жест; tick — пересчитать место. */
export function edgeScroll(scroller: HTMLElement, axis: Axis, at: () => number, tick: () => void): () => void {
  const prop = axis === "y" ? "scrollTop" : "scrollLeft";
  let frame = requestAnimationFrame(function step() {
    const box = scroller.getBoundingClientRect();
    const [start, end] = axis === "y" ? [box.top, box.bottom] : [box.left, box.right];
    // чем ближе к краю, тем быстрее
    const near = at() < start + EDGE ? at() - start - EDGE : at() > end - EDGE ? at() - end + EDGE : 0;
    if (near) {
      scroller[prop] += (near / EDGE) * STEP;
      tick();
    }
    frame = requestAnimationFrame(step);
  });
  return () => cancelAnimationFrame(frame);
}
