// Начало жеста перестановки — одно для фильтров и строк. Мышь: нажать и повести. Палец: удержать, потом вести; повёл раньше — это прокрутка, жеста нет.
const SLOP_MOUSE = 4;
const SLOP_TOUCH = 8;
const HOLD_MS = 300;

export type Press = {
  /** указатель сдвинулся; false — палец повёл раньше времени: жест снят, это прокрутка */
  move(x: number, y: number): boolean;
  /** отпустили или жест снят */
  cancel(): void;
};

export function startPress(e: PointerEvent, begin: () => void): Press {
  const touch = e.pointerType !== "mouse";
  const x0 = e.clientX;
  const y0 = e.clientY;
  let timer = touch ? setTimeout(begin, HOLD_MS) : undefined;
  return {
    move(x, y) {
      const far = Math.hypot(x - x0, y - y0);
      if (touch) {
        if (far <= SLOP_TOUCH) return true;
        clearTimeout(timer);
        timer = undefined;
        return false;
      }
      if (far > SLOP_MOUSE) begin();
      return true;
    },
    cancel: () => clearTimeout(timer),
  };
}
