// Общее жестов списка: край прокрутки, глушение клика после жеста, геометрия области прокрутки.
export const calm = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const SWALLOW_MS = 50;
/** Край списка по высоте: ширина полосы и скорость у края, px/с. */
export const EDGE = 52;
const SPEED = 1400;

/** Скорость прокрутки списка по глубине захода в край: быстрее ближе к краю. */
export const edgeSpeed = (x: number) => SPEED * Math.min(1.7, x / EDGE) ** 2;

export const scrollerOf = (lst: Element) => lst.closest<HTMLElement>(".bd-body")!;

export function viewOf(sc: HTMLElement) {
  const r = sc.getBoundingClientRect();
  return { top: Math.max(r.top, 0), bottom: Math.min(r.bottom, window.innerHeight) };
}

/** Насколько указатель зашёл в полосу края шириной edge у начала и у конца; не зашёл — не больше нуля. */
export const edges = (at: number, from: number, to: number, edge: number) => ({ near: from + edge - at, far: at - (to - edge) });

/** Клик после жеста не считается: ни выбором, ни открытием. */
export function swallowClick(root: HTMLElement, signal: AbortSignal) {
  const swallow = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  root.addEventListener("click", swallow, { capture: true, once: true, signal });
  setTimeout(() => root.removeEventListener("click", swallow, { capture: true }), SWALLOW_MS);
}
