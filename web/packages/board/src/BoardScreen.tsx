// Экран «Работа»: шапка, ряд фильтров, список, панель вида и окно фильтра. Панель и окно — местное состояние экрана.
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Btn, useApp } from "@switchboard/web-ui";
import { useBoard } from "./context.ts";
import { FilterBar } from "./FilterBar.tsx";
import { FilterEditor } from "./filters.tsx";
import { ListView } from "./ListView.tsx";
import type { Filter } from "./rules.ts";
import { useBoardDrag } from "./useBoardDrag.ts";
import { ViewPanel } from "./view.tsx";

export function BoardScreen() {
  const app = useApp();
  const board = useBoard();
  const [panel, setPanel] = useState(false);
  const [editor, setEditor] = useState<{ n: number; base: Filter | null } | null>(null);
  const dense = app.use(() => board.view().dense);
  // на пульте рядом открыт экран сессии: список стоит колонкой
  const side = app.use(() => app.wide && app.current()?.screen !== "board");
  const list = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const { gen, clicked } = useBoardDrag(list);

  useLayoutEffect(() => {
    const el = body.current!;
    el.scrollTop = board.bodyTop();
    return () => board.setBodyTop(el.scrollTop);
  }, [board]);

  const openEditor = useCallback((base: Filter | null) => setEditor((old) => ({ n: (old?.n ?? 0) + 1, base })), []);
  const closeEditor = useCallback(() => setEditor(null), []);
  const chip = useCallback(
    (id: string, on: boolean, fixed: boolean) => {
      if (!clicked()) return;
      if (on && !fixed) openEditor(board.filters().find((f) => f.id === id) ?? null);
      else board.pick(id);
    },
    [board, clicked, openEditor],
  );
  const addFilter = useCallback(() => openEditor(null), [openEditor]);
  const togglePanel = useCallback(() => setPanel((v) => !v), []);

  return (
    <div className={"bd" + (app.wide ? " wide" : "") + (side ? " side" : "")}>
      <div ref={list} className={"bd-list" + (dense ? " dense" : "")}>
        {app.wide ? (
          <div className="bd-lh">
            <b>Работа</b>
            <Btn pri data-new="1" onClick={board.openNew}>
              Новая
            </Btn>
          </div>
        ) : null}
        <div className="fbar">
          <FilterBar gen={gen} panel={panel} chip={chip} add={addFilter} toggle={togglePanel} />
        </div>
        <div ref={body} className="bd-body">
          <ListView gen={gen} />
        </div>
        {panel ? <ViewPanel onClose={() => setPanel(false)} /> : null}
        {editor ? <FilterEditor key={editor.n} base={editor.base} close={closeEditor} /> : null}
      </div>
      {app.wide ? <div className="bd-pick" /> : null}
    </div>
  );
}
