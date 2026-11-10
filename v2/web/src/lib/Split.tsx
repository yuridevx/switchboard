// Перетаскиваемая граница двух панелей — одна на все экраны «список + подробности» и на инспектор.
// Тянется мышью и пальцем, двигается стрелками, двойное нажатие возвращает ширину по умолчанию; ширину помнит устройство — у каждой границы свой ключ.
import { type CSSProperties, type ReactNode, type RefObject, useRef, useState } from "react";
import { useLocal } from "./local.ts";

export type Split = {
  /** ключ ширины на устройстве */
  key: string;
  /** ширина по умолчанию и наименьшая */
  initial: number;
  min: number;
  /** сколько оставить второй части, чтобы она не схлопнулась */
  rest: number;
  /** панель справа: ширина считается от правого края */
  right?: boolean;
  /** имя переменной стиля, в которую идёт ширина */
  cssVar: string;
  label: string;
};

/** Ширина панели в пределах: не уже своей наименьшей и не шире, чем оставляет второй части её наименьшую. */
export const clampSplit = (w: number, total: number, min: number, rest: number): number => Math.round(Math.max(min, Math.min(w, Math.max(min, total - rest))));

/** Граница панели: box — на общий контейнер (position: relative), style — ему же, edge — сама граница внутри него. on: false — границы нет (телефон, панель не показана). */
export function useSplit(o: Split, on = true): { box: RefObject<HTMLDivElement | null>; style: CSSProperties | undefined; pulling: boolean; edge: ReactNode } {
  const box = useRef<HTMLDivElement>(null);
  const [saved, save] = useLocal<number>(o.key, o.initial);
  const [pull, setPull] = useState<number | null>(null);
  const total = () => box.current?.clientWidth ?? 1280;
  const fit = (w: number) => clampSplit(w, total(), o.min, o.rest);
  const w = fit(pull ?? saved);
  const at = (x: number) => {
    const r = box.current?.getBoundingClientRect();
    return fit(o.right ? (r?.right ?? total()) - x : x - (r?.left ?? 0));
  };
  const edge = on ? (
    <div className="pane-edge" role="separator" aria-orientation="vertical" aria-label={o.label} tabIndex={0} aria-valuenow={w} aria-valuemin={o.min} style={{ [o.right ? "right" : "left"]: w - 5 }}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setPull(w); }}
      onPointerMove={(e) => pull !== null && setPull(at(e.clientX))}
      onPointerUp={() => { if (pull !== null) save(pull); setPull(null); }}
      onPointerCancel={() => setPull(null)}
      onDoubleClick={() => save(o.initial)}
      onKeyDown={(e) => { const d = e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : 0; if (d) save(fit(w + (o.right ? -d : d))); }} />
  ) : null;
  return { box, style: on ? ({ [o.cssVar]: `${w}px` } as CSSProperties) : undefined, pulling: pull !== null, edge };
}
