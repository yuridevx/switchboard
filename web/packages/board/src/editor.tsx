// Окно фильтра: одна строка поиска по всем полям; выбранное видно всегда, поле без совпадений свёрнуто.
import { useEffect, useRef, useState } from "react";
import { Btn, Chip, Chips, In, plural, stateLabel, useApp, useModule } from "@switchboard/web-ui";
import { MINE, type Field, type Filter } from "./model.ts";
import type { BoardState } from "./state.ts";

const STATES = ["waiting", "busy", "idle", "failed", "stopped"];

export function FilterEditor({ own, close }: { own?: Filter; close(): void }) {
  const app = useApp();
  const b = useModule<BoardState>();
  const [draft, setDraft] = useState<Filter>(own ?? { id: "", name: "" });
  const [q, setQ] = useState("");
  const name = useRef<HTMLInputElement>(null);
  const options = app.use(() => b.options());
  const fit = app.use(() => b.matching(draft));
  useEffect(() => {
    if (!own) name.current?.focus();
    // окно открылось: фокус один раз
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fields: Array<[Field, string, Array<[string, string]>]> = [
    ["who", "Чьи", [[MINE, "моё"], ...options.who.map((w): [string, string] => [w, w.slice(1)])]],
    ["projects", "Проекты", options.projects.map((p) => [p.id, p.name])],
    ["machines", "Машины", options.machines.map((m) => [m.id, m.name])],
    ["profiles", "Профили", options.profiles.map((p) => [p, p])],
    ["states", "Состояние", STATES.map((s) => [s, stateLabel(s).text])],
  ];
  const needle = q.trim().toLowerCase();
  const shown = fields
    .map(([field, title, list]) => [field, title, list.filter(([v, label]) => draft[field]?.includes(v) || !needle || label.toLowerCase().includes(needle))] as const)
    .filter(([, , list]) => list.length);

  const toggle = (field: Field, v: string) =>
    setDraft((d) => {
      const had = d[field] ?? [];
      const next = had.includes(v) ? had.filter((x) => x !== v) : [...had, v];
      const { [field]: _gone, ...rest } = d;
      return next.length ? { ...rest, [field]: next } : rest;
    });
  function save() {
    const f = { ...draft, name: draft.name.trim(), id: draft.id || `f${Date.now().toString(36)}` };
    b.saveFilter(f);
    b.choose(f.id);
    close();
  }

  return (
    <div
      className="bd-veil"
      data-editor="1"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      <div className="bd-dlg" role="dialog" aria-label="Фильтр">
        <div className="fe-h">
          <b>{own ? "Фильтр" : "Новый фильтр"}</b>
        </div>
        <div className="fe-b">
          <In ref={name} className="fe-name" data-f="name" aria-label="Имя фильтра" placeholder="Имя фильтра" autoComplete="off" value={draft.name} onChange={() => {}} onInput={(e) => setDraft({ ...draft, name: e.currentTarget.value })} />
          <In className="fe-q" data-f="q" aria-label="Найти в фильтре" placeholder="Найти: люди, проекты, машины…" autoComplete="off" value={q} onChange={() => {}} onInput={(e) => setQ(e.currentTarget.value)} />
          <div className="fe-fs">
            {shown.map(([field, title, list]) => (
              <div key={field} className="fe-f" data-field={field}>
                <div className="fe-l">
                  <b>{title}</b>
                </div>
                <Chips className="fe-c">
                  {list.map(([v, label]) => (
                    <Chip key={v} on={!!draft[field]?.includes(v)} data-v={v} onClick={() => toggle(field, v)}>
                      {label}
                    </Chip>
                  ))}
                </Chips>
              </div>
            ))}
            {shown.length ? null : <div className="fe-none">ничего</div>}
          </div>
        </div>
        <div className="fe-ft">
          <span className="fe-n">{`подходит ${fit.sessions} ${plural(fit.sessions, "сессия", "сессии", "сессий")} · ${fit.projects} ${plural(fit.projects, "проект", "проекта", "проектов")}`}</span>
          {own ? (
            <Btn
              bad
              data-act="fdel"
              onClick={() => {
                b.removeFilter(own.id);
                close();
              }}
            >
              Удалить
            </Btn>
          ) : null}
          <Btn onClick={close}>Отмена</Btn>
          <Btn pri data-act="fsave" disabled={!draft.name.trim()} onClick={save}>
            Сохранить
          </Btn>
        </div>
      </div>
    </div>
  );
}
