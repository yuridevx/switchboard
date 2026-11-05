// Общее жестов перестановки: начало жеста, край и прокрутка, захват указателя, клик после жеста.
// Жесты живут вне дерева React и правят элементы напрямую: перерисовка посреди жеста ломает плавность.

const SLOP_MOUSE = 4;
const SLOP_TOUCH = 8;
const HOLD_MS = 300;
const SWALLOW_MS = 50;
/** Край списка по высоте: ширина полосы; скорость у края, px/с. */
export const EDGE = 52;
const SPEED = 1400;

export const calm = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export type Press = {
  /** указатель сдвинулся; false — палец повёл раньше времени: жест снят, это прокрутка */
  move(x: number, y: number): boolean;
  /** отпустили или жест снят */
  cancel(): void;
};

/** Мышь: нажать и повести. Палец: удержать, потом вести; повёл раньше — это прокрутка, жеста нет. */
export function startPress(e: PointerEvent, begin: () => void): Press {
  const touch = e.pointerType !== "mouse";
  const { clientX: x0, clientY: y0 } = e;
  let timer = touch ? setTimeout(begin, HOLD_MS) : undefined;
  return {
    move(x, y) {
      const far = Math.hypot(x - x0, y - y0);
      if (!touch) {
        if (far > SLOP_MOUSE) begin();
        return true;
      }
      if (far <= SLOP_TOUCH) return true;
      clearTimeout(timer);
      timer = undefined;
      return false;
    },
    cancel: () => clearTimeout(timer),
  };
}

export const scrollerOf = (lst: Element) => lst.closest<HTMLElement>(".bd-body")!;

/** Видимая часть области прокрутки по высоте. */
export function viewOf(sc: HTMLElement) {
  const r = sc.getBoundingClientRect();
  return { top: Math.max(r.top, 0), bottom: Math.min(r.bottom, window.innerHeight) };
}

/** Насколько указатель зашёл в полосу края шириной edge у начала и у конца; не зашёл — не больше нуля. */
export const edges = (at: number, from: number, to: number, edge: number) => ({ near: from + edge - at, far: at - (to - edge) });

/** Скорость прокрутки списка по глубине захода в край: быстрее ближе к краю. */
export const edgeSpeed = (x: number) => SPEED * Math.min(1.7, x / EDGE) ** 2;

/** Прокрутка по кадрам: копит дробные пиксели; ответ — сдвинулось ли. */
export function frameScroller(sc: HTMLElement) {
  let last = 0;
  let acc = 0;
  return (now: number, speed: number): boolean => {
    const dt = last ? Math.min(50, now - last) : 0;
    last = now;
    acc = speed ? acc + (speed * dt) / 1000 : 0;
    const step = Math.trunc(acc);
    if (!step) return false;
    const was = sc.scrollTop;
    sc.scrollTop = was + step;
    acc -= step;
    if (sc.scrollTop === was) acc = 0;
    return true;
  };
}

/** Захватить указатель: он мог уже уйти. */
export function capture(el: Element, pid: number) {
  try {
    el.setPointerCapture(pid);
  } catch {
    /* указатель уже ушёл */
  }
}

/** Отпустить указатель: захват мог быть уже снят. */
export function release(el: Element, pid: number) {
  try {
    el.releasePointerCapture(pid);
  } catch {
    /* захват уже снят */
  }
}

/** Клик после жеста не считается: ни выбором, ни открытием. */
export function swallowClick(root: HTMLElement, signal: AbortSignal) {
  const swallow = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  root.addEventListener("click", swallow, { capture: true, once: true, signal });
  setTimeout(() => root.removeEventListener("click", swallow, { capture: true }), SWALLOW_MS);
}
