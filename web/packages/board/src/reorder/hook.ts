// Жесты перестановки подключаются к постоянному элементу списка; решения идут в состояние, конец жеста рисует список заново.
import { useLayoutEffect, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useBoard } from "../state.ts";
import { attachChips } from "./chips.ts";
import { attachProjects } from "./projects.ts";

/** Ответ — поколение рисунка: жест менял элементы напрямую, новое поколение строит их заново. */
export function useReorder(list: RefObject<HTMLDivElement | null>) {
  const board = useBoard();
  const [gen, setGen] = useState(0);

  useLayoutEffect(() => {
    const root = list.current!;
    const ac = new AbortController();
    // конец жеста: сразу новый рисунок — жест дальше читает его элементы; выборки строк догоняют уведомлением
    const redraw = () => {
      const left = root.querySelector(".fscroll")?.scrollLeft ?? 0;
      flushSync(() => setGen((g) => g + 1));
      root.querySelector(".fscroll")!.scrollLeft = left;
    };
    const reordering = board.setReordering;
    attachProjects({ root, place: board.moveProject, menu: board.toggleMenu, rowsMove: board.rowsMove, placeRows: board.placeRows, reordering, redraw }, ac.signal);
    attachChips({ root, place: board.placeChips, reordering, redraw }, ac.signal);
    return () => {
      ac.abort();
      reordering(false);
    };
  }, [board, list]);

  return gen;
}
