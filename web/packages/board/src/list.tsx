// Список «Работы»: проекты или плоско. Строка читает только своё: на изменение одной сессии перерисовывается она одна.
// gen — поколение после перестановки: жест менял элементы напрямую, поэтому они строятся заново.
import { memo, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { Badge, Btn, DisclosureBtn, Dot, IconBtn, In, RowBtn, TextBtn, useApp } from "@switchboard/web-ui";
import type { RowItem, Section } from "./model.ts";
import { useBoard, useHeld } from "./state.ts";

const SessionRow = memo(function SessionRow({ callsign, depth, noAt, project }: Omit<RowItem, "k">) {
  const board = useBoard();
  const d = useHeld(() => board.rowData(callsign, noAt, project));
  if (!d) return null;
  return (
    <RowBtn
      className={"bd-row" + (depth ? " kid" : "")}
      data-callsign={callsign}
      aria-current={d.current ? "true" : "false"}
      style={depth ? { paddingLeft: `${10 + depth * 22}px` } : undefined}
      onClick={() => {
        const s = board.session(callsign);
        if (s) board.openSession(s);
      }}
    >
      {d.lamp ? <Dot kind={d.lamp} title={d.title} /> : null}
      <span className="bd-rt">
        <span className="bd-t1">
          <b className={"bd-cs" + (d.human ? " hum" : "")}>{d.name}</b>
          {d.owner ? <span className="bd-pill own">{d.owner}</span> : null}
          {d.inc ? <span className="bd-pill inc">{d.inc}</span> : null}
          {d.pin ? (
            <svg className="bd-pin" viewBox="0 0 16 16" role="img" aria-label="закреплена">
              <path d="M6 2h4l-.5 4 2.5 2.5V10H8.6L8 14l-.6-4H4V8.5L6.5 6z" />
            </svg>
          ) : null}
          {d.at !== null ? <span className={"bd-at" + (d.atHuman ? " hum" : "")}>{d.at}</span> : null}
        </span>
        {d.t2.length ? (
          <span className="bd-t2">
            {d.t2.map((x) => (
              <span key={x.c} className={x.c}>
                {x.t}
              </span>
            ))}
          </span>
        ) : null}
      </span>
      {d.badge === "?" ? (
        <Badge wait aria-label="ждёт ответа">
          ?
        </Badge>
      ) : d.badge ? (
        <Badge>{d.badge}</Badge>
      ) : null}
    </RowBtn>
  );
});

/** Поле имени: Enter и уход с поля подтверждают, Esc отменяет. Значение живёт в поле. */
function NameField({ commit, cancel, ...p }: { commit(value: string): void; cancel(): void } & ComponentProps<typeof In>) {
  return (
    <In
      autoFocus
      autoComplete="off"
      {...p}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(e.currentTarget.value);
        if (e.key === "Escape") cancel();
      }}
      onBlur={(e) => commit(e.currentTarget.value)}
    />
  );
}

function ProjectMenu({ id, name }: { id: string; name: string }) {
  const board = useBoard();
  const save = (value: string) => {
    const v = value.trim();
    if (v && v !== name) board.renameProject(id, v);
    board.closeMenu();
  };
  return (
    <div className="pj-menu" data-menu={id}>
      <NameField data-f="project-name" defaultValue={name} aria-label="Имя проекта" commit={save} cancel={board.closeMenu} />
      <Btn
        bad
        data-act="project-remove"
        onPointerDown={(e: { preventDefault(): void }) => e.preventDefault()}
        onClick={() => {
          board.removeProject(id);
          board.closeMenu();
        }}
      >
        Удалить
      </Btn>
    </div>
  );
}

/** Последняя строка списка: новый проект. */
function NewProject() {
  const board = useBoard();
  const [on, setOn] = useState(false);
  if (!on) {
    return (
      <TextBtn className="pj-new" data-act="project-new" onClick={() => setOn(true)}>
        Новый проект
      </TextBtn>
    );
  }
  const commit = (v: string) => {
    if (v.trim()) board.addProject(v);
    setOn(false);
  };
  return <NameField className="pj-newin" data-f="project-new" aria-label="Имя нового проекта" commit={commit} cancel={() => setOn(false)} />;
}

const ProjectSection = memo(function ProjectSection({ x }: { x: Section }) {
  const board = useBoard();
  return (
    <section className="pjs" data-proj={x.id}>
      <div className="pj">
        {x.grip ? (
          <span className="grip" role="button" tabIndex={0} data-proj={x.id} aria-label={`Проект ${x.name}: перетащить, стрелки или нажать — имя и удаление`}>
            ⠿
          </span>
        ) : null}
        <DisclosureBtn className="pj-t" open={x.open} data-proj={x.id} onClick={() => board.toggleProject(x.id)}>
          <span className="car">▼</span>
          <span className="nm">{x.name}</span>
          <span className="lamps">
            {x.lamps.map((l) => (
              <Dot key={l.callsign} kind={l.kind} />
            ))}
          </span>
        </DisclosureBtn>
        {x.add ? (
          <IconBtn className="pj-add" data-proj={x.id} aria-label={`Новая сессия в ${x.name}`} onClick={() => board.newIn(x.id)}>
            +
          </IconBtn>
        ) : null}
      </div>
      {x.menu ? <ProjectMenu id={x.id} name={x.name} /> : null}
      {x.items.map((it) =>
        it.k === "group" ? (
          <div key={`g:${it.machine}`} className="mgrp" data-group={it.machine}>
            <span>{it.label}</span>
            <span className="n">{String(it.n)}</span>
          </div>
        ) : (
          <SessionRow key={it.callsign} callsign={it.callsign} depth={it.depth} noAt={it.noAt} project={it.project} />
        ),
      )}
    </section>
  );
});

export const List = memo(function List({ gen }: { gen: number }) {
  const app = useApp();
  const board = useBoard();
  const m = useHeld(board.listModel);
  const current = app.use(() => app.current()?.params.callsign);
  const lst = useRef<HTMLDivElement>(null);
  /** открытая сессия, которую список уже показал */
  const shown = useRef<string | undefined>(undefined);
  const ready = !!m;

  // строка появляется, когда её проект развернулся: показать, как только она есть
  useLayoutEffect(() => {
    if (!ready || current === shown.current) return;
    const row = current ? lst.current?.querySelector<HTMLElement>(`[data-callsign=${JSON.stringify(current)}]`) : null;
    if (current && !row) return;
    shown.current = current;
    row?.scrollIntoView?.({ block: "nearest" });
  }, [ready, m, current]);

  if (!m) return null;
  const empty = <div className="bd-empty">{m.empty}</div>;
  if (m.flat) {
    return (
      <div key={gen} ref={lst} className="lst flat">
        {m.flat.length ? m.flat.map((it) => <SessionRow key={it.callsign} callsign={it.callsign} depth={it.depth} noAt={it.noAt} project={it.project} />) : empty}
      </div>
    );
  }
  return (
    <div key={gen} ref={lst} className="lst">
      {m.sections.map((x) => (
        <ProjectSection key={`p:${x.id}`} x={x} />
      ))}
      {m.sections.length ? null : empty}
      <NewProject />
    </div>
  );
});
