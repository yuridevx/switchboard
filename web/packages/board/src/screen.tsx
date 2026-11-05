// Экран «Работа»: шапка, ряд фильтров, список, панель вида и окно фильтра.
import { flushSync } from "react-dom";
import { useLayoutEffect, useReducer, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Btn, Chip, Choices, IconBtn, RowBtn, useApp, useModule } from "@switchboard/web-ui";
import { FilterEditor } from "./editor.tsx";
import { glide, press, sorter } from "./gesture.ts";
import { List } from "./list.tsx";
import { VIEW_GROUPS, type Filter } from "./model.ts";
import type { BoardState, Chip as ChipModel } from "./state.ts";

const cx = (...names: unknown[]) => names.filter(Boolean).join(" ");

function Panel({ view, close }: { view: Record<string, boolean>; close(): void }) {
  const app = useApp();
  const b = useModule<BoardState>();
  return (
    <div className="bd-vw" role="dialog" aria-label="Вид списка" data-hide-tabs="">
      <div className="vw-h">
        <b>Вид списка</b>
        <Btn
          className="vw-x"
          data-act="view-reset"
          onClick={() => {
            b.resetView();
            if (app.wide) app.run("card.head.reset");
          }}
        >
          Вернуть
        </Btn>
        {app.wide ? (
          <Btn className="vw-x" aria-label="Закрыть" onClick={close}>
            ✕
          </Btn>
        ) : (
          <Btn pri className="vw-x" onClick={close}>
            Готово
          </Btn>
        )}
      </div>
      <div className="vw-b">
        {VIEW_GROUPS.map(([title, units]) => (
          <Choices key={title} title={title}>
            {units.map(([key, label, full]) => (
              <Chip key={key} on={view[key]} data-v={key} aria-label={full} disabled={key === "group" && !view.projects} onClick={() => b.setView(key, !view[key])}>
                {label}
              </Chip>
            ))}
          </Choices>
        ))}
        {app.wide ? (
          <div>
            <app.Slot screen="card.view" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

const Tune = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M2 4h7M13 4h1M2 12h1M7 12h7" />
    <circle cx="11" cy="4" r="1.9" />
    <circle cx="5" cy="12" r="1.9" />
  </svg>
);

/** Ряд фильтров: нажатие выбирает, повторное — окно своего; перетаскивание и Alt со стрелкой — порядок. */
function Chips({ chips, selected, view, rerender, openEditor, panel, togglePanel }: { chips: ChipModel[]; selected: string; view: Record<string, boolean>; rerender(): void; openEditor(f?: Filter): void; panel: boolean; togglePanel(): void }) {
  const b = useModule<BoardState>();
  const box = useRef<HTMLDivElement>(null);
  const ids = chips.map((c) => c.id);

  function down(e: PointerEvent<HTMLElement>, id: string) {
    const item = e.currentTarget;
    const row = box.current!;
    press(e, {
      hold: true,
      scroller: { el: row, axis: "x" },
      lift(x) {
        b.hold(true);
        const others = [...row.querySelectorAll<HTMLElement>(":scope > .fc")].filter((el) => el !== item);
        const root = item.closest<HTMLElement>(".bd-list")!;
        return sorter({
          axis: "x",
          root,
          box: row,
          item,
          others,
          source: item,
          cls: { copy: "fc-ghost", up: "lifted", land: "landing", slot: "fc-slot", box: "fc-sorting" },
          open: () => root.classList.add("reordering"),
          close() {
            root.classList.remove("reordering");
            b.hold(false);
          },
          dress(copy, _at, size) {
            copy.setAttribute("tabindex", "-1");
            copy.style.width = `${size.width}px`;
            copy.style.height = `${size.height}px`;
          },
          put: (copy, main, cross) => void (copy.style.translate = `${main}px ${cross}px`),
          landMs: 200,
          pointer: x,
          commit(i) {
            const order = others.map((el) => el.dataset.fid!);
            order.splice(i, 0, id);
            b.setRow(order);
          },
        });
      },
    });
  }
  function key(e: KeyboardEvent<HTMLElement>, id: string) {
    if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const i = ids.indexOf(id);
    const to = e.key === "ArrowLeft" ? i - 1 : i + 1;
    if (to < 0 || to >= ids.length) return;
    const order = ids.filter((x) => x !== id);
    order.splice(to, 0, id);
    glide(box.current!, ":scope > .fc", "fc-glide", () => {
      b.setRow(order);
      rerender();
    });
    box.current!.querySelector<HTMLElement>(`[data-fid="${CSS.escape(id)}"]`)?.focus();
  }

  return (
    <div className="fbar">
      <div ref={box} className="fscroll" role="tablist" aria-label="Фильтры">
        {chips.map((c) => (
          <RowBtn
            key={c.id}
            className="fc"
            role="tab"
            aria-selected={c.id === selected ? "true" : "false"}
            data-fid={c.id}
            onPointerDown={(e) => down(e, c.id)}
            onKeyDown={(e) => key(e, c.id)}
            onClick={() => {
              if (c.id !== selected) b.choose(c.id);
              else if (c.own) openEditor(b.filterOf(c.id));
            }}
          >
            {c.name}
            {view.fcount ? <span className="n">{c.count}</span> : null}
            {c.own && c.id === selected ? (
              <span className="ed" aria-hidden="true">
                ✎
              </span>
            ) : null}
          </RowBtn>
        ))}
      </div>
      <IconBtn className="fc add" aria-label="Новый фильтр" onClick={() => openEditor()}>
        +
      </IconBtn>
      <IconBtn className="fc vw" aria-label="Вид списка" aria-expanded={panel} onClick={togglePanel}>
        <Tune />
      </IconBtn>
    </div>
  );
}

export function BoardScreen() {
  const app = useApp();
  const b = useModule<BoardState>();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  // перестановка с клавиатуры видна сразу, до конца обработчика
  const rerender = () => flushSync(bump);
  const m = app.use<ReturnType<BoardState["model"]>>((prev) => (b.held() && prev ? prev : b.model()));
  const side = app.use(() => app.current()?.master === "board");
  const current = app.use(() => app.current()?.params.callsign ?? null);
  const [panel, setPanel] = useState(false);
  const [editor, setEditor] = useState<{ own?: Filter } | null>(null);
  const body = useRef<HTMLDivElement>(null);
  // возврат к списку — на той же прокрутке
  useLayoutEffect(() => {
    const el = body.current!;
    el.scrollTop = b.scroll.top;
    return () => void (b.scroll.top = el.scrollTop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={cx("bd", app.wide && "wide", side && "side")}>
      <div className={cx("bd-list", m.view.dense && "dense")}>
        {app.wide ? (
          <div className="bd-lh">
            <b>Работа</b>
            <Btn pri data-new="1" onClick={() => app.open("open")}>
              Новая
            </Btn>
          </div>
        ) : null}
        <Chips chips={m.chips} selected={m.selected} view={m.view} rerender={rerender} openEditor={(own) => setEditor({ own })} panel={panel} togglePanel={() => setPanel(!panel)} />
        <div ref={body} className="bd-body">
          <List m={m} current={current} rerender={rerender} />
        </div>
        {panel ? <Panel view={m.view} close={() => setPanel(false)} /> : null}
        {editor ? <FilterEditor own={editor.own} close={() => setEditor(null)} /> : null}
      </div>
      {app.wide ? <div className="bd-pick" /> : null}
    </div>
  );
}
