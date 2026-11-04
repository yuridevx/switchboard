// Ряд фильтров: «Моё», «Всё» и свои; число — сколько подходит. Что делать по нажатию, решает экран.
import { memo } from "react";
import { useBoard } from "./store.ts";
import { useHeld } from "./useHeld.ts";

type Props = { gen: number; panel: boolean; chip(id: string, on: boolean, fixed: boolean): void; add(): void; toggle(): void };

export const FilterBar = memo(function FilterBar({ gen, panel, chip, add, toggle }: Props) {
  const board = useBoard();
  const chips = useHeld(board.barModel);
  if (!chips) return null;
  return (
    <>
      <div key={gen} className="fscroll" role="tablist" aria-label="Фильтры">
        {chips.map((f) => (
          <button key={f.id} className="fc" role="tab" data-fid={f.id} aria-selected={f.on} onClick={() => chip(f.id, f.on, f.fixed)}>
            {f.name}
            {f.n !== null ? <span className="n">{String(f.n)}</span> : null}
            {f.on && !f.fixed ? (
              <span className="ed" aria-hidden="true">
                ✎
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <button className="fc add" aria-label="Новый фильтр" onClick={add}>
        +
      </button>
      <button className="fc vw" aria-label="Вид списка" aria-expanded={panel} onClick={toggle}>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="M2 4h7M13 4h1M2 12h1M7 12h7" />
          <circle cx="11" cy="4" r="1.9" />
          <circle cx="5" cy="12" r="1.9" />
        </svg>
      </button>
    </>
  );
});
