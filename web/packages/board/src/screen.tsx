// Экран «Работа»: шапка, ряд фильтров, список, панель вида и окно фильтра. Панель и окно — местное состояние экрана.
import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import { Btn, IconBtn, RowBtn, useApp } from "@switchboard/web-ui";
import { FilterEditor } from "./filter-editor.tsx";
import { List } from "./list.tsx";
import { useReorder } from "./reorder/hook.ts";
import type { Filter } from "./rules.ts";
import { useBoard, useHeld } from "./state.ts";
import { ViewPanel } from "./view-panel.tsx";

type BarProps = { gen: number; panel: boolean; chip(id: string, on: boolean, fixed: boolean): void; add(): void; toggle(): void };

/** Ряд фильтров: число — сколько подходит. Что делать по нажатию, решает экран. */
const FilterBar = memo(function FilterBar({ gen, panel, chip, add, toggle }: BarProps) {
  const board = useBoard();
  const chips = useHeld(board.barModel);
  if (!chips) return null;
  return (
    <>
      <div key={gen} className="fscroll" role="tablist" aria-label="Фильтры">
        {chips.map((f) => (
          <RowBtn key={f.id} className="fc" role="tab" data-fid={f.id} aria-selected={f.on} onClick={() => chip(f.id, f.on, f.fixed)}>
            {f.name}
            {f.n !== null ? <span className="n">{String(f.n)}</span> : null}
            {f.on && !f.fixed ? (
              <span className="ed" aria-hidden="true">
                ✎
              </span>
            ) : null}
          </RowBtn>
        ))}
      </div>
      <IconBtn className="fc add" aria-label="Новый фильтр" onClick={add}>
        +
      </IconBtn>
      <IconBtn className="fc vw" aria-label="Вид списка" aria-expanded={panel} onClick={toggle}>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="M2 4h7M13 4h1M2 12h1M7 12h7" />
          <circle cx="11" cy="4" r="1.9" />
          <circle cx="5" cy="12" r="1.9" />
        </svg>
      </IconBtn>
    </>
  );
});

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
  const gen = useReorder(list);

  useLayoutEffect(() => {
    const el = body.current!;
    el.scrollTop = board.bodyTop();
    return () => board.setBodyTop(el.scrollTop);
  }, [board]);

  const edit = useCallback((base: Filter | null) => setEditor((old) => ({ n: (old?.n ?? 0) + 1, base })), []);
  const closeEditor = useCallback(() => setEditor(null), []);
  const chip = useCallback(
    (id: string, on: boolean, fixed: boolean) => {
      if (on && !fixed) edit(board.filters().find((f) => f.id === id) ?? null);
      else board.pick(id);
    },
    [board, edit],
  );
  const add = useCallback(() => edit(null), [edit]);
  const toggle = useCallback(() => setPanel((v) => !v), []);

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
          <FilterBar gen={gen} panel={panel} chip={chip} add={add} toggle={toggle} />
        </div>
        <div ref={body} className="bd-body">
          <List gen={gen} />
        </div>
        {panel ? <ViewPanel onClose={() => setPanel(false)} /> : null}
        {editor ? <FilterEditor key={editor.n} base={editor.base} close={closeEditor} /> : null}
      </div>
      {app.wide ? <div className="bd-pick" /> : null}
    </div>
  );
}
