// Перестановка в списке: движки жестов живут вне дерева React и правят элементы напрямую; решения идут в store, конец жеста рисует список заново.
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useBoard } from "./store.ts";
import { attachChipDrag } from "./chips-drag.ts";
import { attachProjectDrag } from "./projects-drag.ts";

const SWALLOW_MS = 50;

/** Подключить жесты к постоянному элементу списка. gen — поколение рисунка; clicked — считать ли click по чипу выбором. */
export function useBoardDrag(list: RefObject<HTMLDivElement | null>) {
  const board = useBoard();
  const [gen, setGen] = useState(0);
  const swallowed = useRef(false);

  useLayoutEffect(() => {
    const root = list.current!;
    const ac = new AbortController();
    // конец жеста: сразу новый рисунок — жест дальше читает его элементы; выборки строк догоняют уведомлением
    const redraw = () => {
      const left = root.querySelector(".fscroll")?.scrollLeft ?? 0;
      flushSync(() => setGen((g) => g + 1));
      root.querySelector(".fscroll")!.scrollLeft = left;
    };
    attachProjectDrag({ root, place: board.moveProject, menu: board.toggleMenu, rowsMove: board.rowsMove, placeRows: board.placeRows, reordering: board.setReordering, redraw }, ac.signal);
    attachChipDrag(
      {
        root,
        place: board.placeChips,
        reordering: board.setReordering,
        redraw,
        swallow: () => {
          swallowed.current = true;
          setTimeout(() => (swallowed.current = false), SWALLOW_MS);
        },
      },
      ac.signal,
    );
    return () => {
      ac.abort();
      board.setReordering(false);
    };
  }, [board, list]);

  const clicked = useCallback(() => !swallowed.current, []);
  return { gen, clicked };
}
