// Проект в списке: заголовок с ручкой, лампами и «+», меню имени и строки. И последняя строка списка — новый проект.
import { memo, useState } from "react";
import { Btn, Dot, In } from "@switchboard/web-ui";
import { useBoard } from "./store.ts";
import type { Section } from "./model.ts";
import { SessionRow } from "./SessionRow.tsx";

/** Меню проекта: имя и «Удалить». Значение нужно только при вводе — Enter или уход с поля; пока правят, оно живёт в поле. */
function ProjectMenu({ id, name }: { id: string; name: string }) {
  const board = useBoard();
  const save = (value: string) => {
    const v = value.trim();
    if (v && v !== name) board.renameProject(id, v);
    board.closeMenu();
  };
  return (
    <div className="pj-menu" data-menu={id}>
      <In
        autoFocus
        data-f="project-name"
        defaultValue={name}
        aria-label="Имя проекта"
        autoComplete="off"
        onKeyDown={(e) => {
          if (e.key === "Enter") save(e.currentTarget.value);
          if (e.key === "Escape") board.closeMenu();
        }}
        onBlur={(e) => save(e.currentTarget.value)}
      />
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
export function NewProject() {
  const board = useBoard();
  const [on, setOn] = useState(false);
  if (!on) {
    return (
      <button className="pj-new" data-act="project-new" onClick={() => setOn(true)}>
        Новый проект
      </button>
    );
  }
  const done = (v: string) => {
    if (v.trim()) board.addProject(v);
    setOn(false);
  };
  return (
    <In
      className="pj-newin"
      data-f="project-new"
      aria-label="Имя нового проекта"
      autoComplete="off"
      autoFocus
      onKeyDown={(e) => {
        if (e.key === "Enter") done(e.currentTarget.value);
        if (e.key === "Escape") setOn(false);
      }}
      onBlur={(e) => done(e.currentTarget.value)}
    />
  );
}

export const ProjectSection = memo(function ProjectSection({ x }: { x: Section }) {
  const board = useBoard();
  return (
    <section className="pjs" data-proj={x.id}>
      <div className="pj">
        {x.grip ? (
          <span className="grip" role="button" tabIndex={0} data-proj={x.id} aria-label={`Проект ${x.name}: перетащить, стрелки или нажать — имя и удаление`}>
            ⠿
          </span>
        ) : null}
        <button className="pj-t" aria-expanded={x.open} data-proj={x.id} onClick={() => board.toggleProject(x.id)}>
          <span className="car">▼</span>
          <span className="nm">{x.name}</span>
          <span className="lamps">
            {x.lamps.map((l) => (
              <Dot key={l.callsign} kind={l.kind} />
            ))}
          </span>
        </button>
        {x.add ? (
          <button className="pj-add" data-proj={x.id} aria-label={`Новая сессия в ${x.name}`} onClick={() => board.newIn(x.id)}>
            +
          </button>
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
