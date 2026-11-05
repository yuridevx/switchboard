// Список: проекты, строки и правка проекта на месте. Жест начинается здесь: что поднять и что записать при броске.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { NONE } from "@switchboard/records";
import { Badge, Btn, DisclosureBtn, Dot, IconBtn, In, RowBtn, TextBtn, useApp, useModule } from "@switchboard/web-ui";
import { glide, press, rowDrag, sorter } from "./gesture.ts";
import type { BoardState, RowModel, SectionModel } from "./state.ts";

const cx = (...names: unknown[]) => names.filter(Boolean).join(" ");
const closest = (el: Element, sel: string) => el.closest<HTMLElement>(sel)!;

function Row({ row, current, onDown, onOpen }: { row: RowModel; current: boolean; onDown?(e: PointerEvent<HTMLElement>, row: RowModel): void; onOpen(callsign: string): void }) {
  const hum = (human: boolean) => (human ? "hum" : "");
  return (
    <RowBtn className={cx("bd-row", row.depth && "kid")} aria-current={current ? "true" : "false"} data-callsign={row.callsign} style={row.depth ? { paddingLeft: 10 + 22 * row.depth } : undefined} onClick={() => onOpen(row.callsign)} onPointerDown={onDown && ((e) => onDown(e, row))}>
      {row.dot ? <Dot kind={row.dot} title={row.title} /> : null}
      <span className="bd-rt">
        <span className="bd-t1">
          <b className={cx("bd-cs", hum(row.name.human))}>{row.name.text}</b>
          {row.pinned ? (
            <svg className="bd-pin" viewBox="0 0 16 16" role="img" aria-label="закреплена">
              <path d="M6 2h4l-.5 4 2.5 2.5V10H8.6L8 14l-.6-4H4V8.5L6.5 6z" />
            </svg>
          ) : null}
          {row.own ? <span className="bd-pill own">{row.own}</span> : null}
          {row.inc ? <span className="bd-pill inc">{row.inc}</span> : null}
          {row.at ? <span className={cx("bd-at", hum(row.at.human))}>{row.at.text}</span> : null}
        </span>
        <span className="bd-t2">
          {row.project ? <span className="prj">{row.project}</span> : null}
          {row.line.kind ? (
            <span className={cx("tx", row.line.kind !== "u" && row.line.kind)}>{row.line.text}</span>
          ) : (
            <>
              {row.prof ? <span className="bd-pill">{row.prof}</span> : null}
              {row.model ? <span className="tx">{row.model}</span> : null}
            </>
          )}
        </span>
      </span>
      {row.badge ? (
        <Badge wait={row.badge.wait} aria-label={row.badge.wait ? "ждёт ответа" : undefined}>
          {row.badge.text}
        </Badge>
      ) : null}
    </RowBtn>
  );
}

/** Поле имени: значение читается из самого поля; Enter и уход — записать, Esc — нет. */
function NameField({ commit, cancel, ...p }: Parameters<typeof In>[0] & { commit(text: string): void; cancel(): void }) {
  const done = useRef(false);
  const finish = (act: () => void) => {
    if (done.current) return;
    done.current = true;
    act();
  };
  return (
    <In
      {...p}
      autoComplete="off"
      autoFocus
      onBlur={(e) => {
        const text = e.currentTarget.value;
        finish(() => commit(text));
      }}
      onKeyDown={(e) => {
        const text = e.currentTarget.value;
        if (e.key === "Enter") finish(() => commit(text));
        if (e.key === "Escape") finish(cancel);
      }}
    />
  );
}

type Model = ReturnType<BoardState["model"]>;

export function List({ m, current, rerender }: { m: Model; current: string | null; rerender(): void }) {
  const app = useApp();
  const b = useModule<BoardState>();
  const [menu, setMenu] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const { view } = m;
  const box = useRef<HTMLDivElement>(null);
  // открытая строка всегда видна
  useEffect(() => {
    if (current) box.current?.querySelector(`.bd-row[data-callsign="${CSS.escape(current)}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  const openRow = (callsign: string) => app.open(!app.wide && app.mark("asked", callsign) ? "ask" : "card", { callsign });

  function downGrip(e: PointerEvent<HTMLElement>, id: string) {
    const item = closest(e.currentTarget, ".pjs");
    const root = closest(item, ".bd-list");
    const box = closest(item, ".lst");
    press(e, {
      hold: false,
      scroller: { el: closest(item, ".bd-body"), axis: "y" },
      lift(_x, y) {
        b.hold(true);
        const others = [...box.querySelectorAll<HTMLElement>(":scope > .pjs")].filter((el) => el !== item && el.dataset.proj !== NONE);
        const head = item.querySelector<HTMLElement>(".pj")!;
        const tall = box.offsetHeight;
        return sorter({
          axis: "y",
          root,
          box,
          item,
          others,
          source: head,
          anchor: ".pj-t",
          cls: { copy: "dnd-card", up: "up", land: "land", slot: "dnd-slot dnd-folded", box: "dnd-on" },
          open() {
            root.classList.add("reordering");
            box.style.minHeight = `${tall}px`;
            item.style.height = `${head.offsetHeight}px`;
          },
          close() {
            root.classList.remove("reordering");
            box.style.minHeight = "";
            item.style.height = "";
            b.hold(false);
          },
          dress(copy, at, size) {
            copy.setAttribute("inert", "");
            copy.style.left = `${at.x}px`;
            copy.style.width = `${size.width}px`;
            copy.querySelector(".pj-t")!.setAttribute("aria-expanded", "false");
          },
          put: (copy, main) => void (copy.style.translate = `0px ${main}px`),
          landMs: 220,
          pointer: y,
          commit: (i) => b.moveProject(id, others[i]?.dataset.proj ?? null),
        });
      },
    });
  }

  function downRow(e: PointerEvent<HTMLElement>, row: RowModel, section: SectionModel) {
    const el = e.currentTarget;
    const root = closest(el, ".bd-list");
    const list = closest(el, ".lst");
    press(e, {
      hold: true,
      scroller: { el: closest(el, ".bd-body"), axis: "y" },
      lift(_x, y) {
        b.hold(true);
        const at = section.rows.indexOf(row);
        const after = section.rows.slice(at + 1);
        const stop = after.findIndex((r) => r.depth <= row.depth);
        const kids = stop < 0 ? after : after.slice(0, stop);
        const names = [row, ...kids].map((r) => r.callsign);
        const block = names.map((cs) => list.querySelector<HTMLElement>(`[data-callsign="${CSS.escape(cs)}"]`)!);
        const next = stop < 0 ? null : after[stop].callsign;
        return rowDrag({
          root,
          list,
          row: el,
          block,
          y,
          drop: (project, before) => void (project === section.id && before === next ? null : b.dropRows(names, project, before, b.shownIn(project))),
          end: () => b.hold(false),
        });
      },
    });
  }

  function keyGrip(e: KeyboardEvent<HTMLElement>, id: string) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      return setMenu(id);
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const order = m.order.filter((x) => x !== NONE);
    const i = order.indexOf(id);
    if (e.key === "ArrowUp" ? i === 0 : i === order.length - 1) return;
    const list = closest(e.currentTarget, ".lst");
    glide(list, ":scope > .pjs", "dnd-on", () => {
      b.moveProject(id, e.key === "ArrowUp" ? order[i - 1] : (order[i + 2] ?? null));
      rerender();
    });
    list.querySelector<HTMLElement>(`.grip[data-proj="${CSS.escape(id)}"]`)?.focus();
  }

  const rowsOf = (s: SectionModel, rows: RowModel[]) => rows.map((r) => <Row key={r.callsign} row={r} current={current === r.callsign} onDown={(e) => downRow(e, r, s)} onOpen={openRow} />);

  if (!view.projects) {
    return (
      <div ref={box} className="lst flat">
        {m.flat.map((r) => (
          <Row key={r.callsign} row={r} current={current === r.callsign} onOpen={openRow} />
        ))}
        {m.drawn && !m.flat.length ? <div className="bd-empty">{`в «${m.selectedName}» сессий нет`}</div> : null}
      </div>
    );
  }
  if (!m.drawn) return <div ref={box} className="lst" />;
  return (
    <div ref={box} className="lst">
      {m.sections.map((s) => (
        <section key={s.id} className="pjs" data-proj={s.id}>
          <div className="pj">
            {view.grip && s.id !== NONE ? (
              <span className="grip" role="button" tabIndex={0} data-proj={s.id} aria-label={`Проект ${s.name}: перетащить, стрелки или нажать — имя и удаление`} onPointerDown={(e) => downGrip(e, s.id)} onClick={() => setMenu(menu === s.id ? null : s.id)} onKeyDown={(e) => keyGrip(e, s.id)}>
                ⠿
              </span>
            ) : null}
            <DisclosureBtn open={!s.collapsed} className="pj-t" data-proj={s.id} onClick={() => b.toggle(s.id)}>
              <span className="car">▼</span>
              <span className="nm">{s.name}</span>
              <span className="lamps">
                {s.lamps.map((kind, i) => (
                  <Dot key={i} kind={kind} />
                ))}
              </span>
            </DisclosureBtn>
            {view.add ? (
              <IconBtn className="pj-add" data-proj={s.id} aria-label={`Новая сессия в ${s.name}`} onClick={() => app.open("open", b.placeOf(s.id))}>
                +
              </IconBtn>
            ) : null}
          </div>
          {menu === s.id ? (
            <div className="pj-menu" data-menu={s.id}>
              <NameField
                data-f="project-name"
                aria-label="Имя проекта"
                defaultValue={s.name}
                commit={(text) => {
                  if (text.trim() && text.trim() !== s.name) b.renameProject(s.id, text);
                  setMenu(null);
                }}
                cancel={() => setMenu(null)}
              />
              <Btn
                bad
                data-act="project-remove"
                onPointerDown={(e) => e.preventDefault()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  b.removeProject(s.id);
                  setMenu(null);
                }}
              >
                Удалить
              </Btn>
            </div>
          ) : null}
          {s.groups
            ? s.groups.map((g) => [
                <div key={`g:${g.machine}`} className="mgrp" data-group={g.machine}>
                  <span>{g.label}</span>
                  <span className="n">{g.rows.length}</span>
                </div>,
                ...rowsOf(s, g.rows),
              ])
            : rowsOf(s, s.rows)}
        </section>
      ))}
      {!m.sections.length ? <div className="bd-empty">{`в «${m.selectedName}» сессий нет`}</div> : null}
      {adding ? (
        <NameField
          className="pj-newin"
          data-f="project-new"
          aria-label="Имя нового проекта"
          commit={(text) => {
            if (text.trim()) b.addProject(text);
            setAdding(false);
          }}
          cancel={() => setAdding(false)}
        />
      ) : (
        <TextBtn className="pj-new" data-act="project-new" onClick={() => setAdding(true)}>
          Новый проект
        </TextBtn>
      )}
    </div>
  );
}
