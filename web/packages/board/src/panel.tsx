// Окна «Работы»: панель вида и окно фильтра.
import { useState, type KeyboardEvent } from "react";
import { machineOf, userOf } from "@switchboard/protocol";
import { Btn, Chip, Chips, Choices, In, machineLabel, profileIdOf, profileName, stateLabel, useApp, useModule } from "@switchboard/web-ui";
import { fitLine, VIEW, type Filter, type FilterField, type View } from "./model.ts";
import type { BoardState } from "./state.ts";

type Unit = [keyof View, string, string];
const GROUPS: Array<[string, Unit[]]> = [
  ["Список", [["projects", "По проектам", "Группировать по проектам"], ["group", "По машинам", "Группы по машинам в проекте"], ["tree", "Дочерние", "Дочерние под родителем"], ["dense", "В одну строку", "В одну строку"]]],
  ["Строка", [["lamp", "Лампа", "Лампа состояния"], ["at", "Машина", "Машина"], ["owner", "Владелец", "Владелец чужой сессии"], ["pin", "Закрепление", "Значок закрепления"], ["inc", "Инцидент", "Инцидент"], ["badge", "«?» и число", "Значок вопроса и непрочитанного"], ["q", "Вопрос", "Текст вопроса"], ["unread", "Непрочитанное", "Текст непрочитанного"], ["fail", "Сбой", "Причина сбоя"], ["prof", "Профиль", "Профиль"], ["model", "Модель", "Модель"]]],
  ["Проект", [["pjlamps", "Лампы", "Лампы свёрнутого проекта"], ["grip", "Ручка", "Ручка перетаскивания"], ["add", "«+»", "Кнопка новой сессии"]]],
  ["Фильтры", [["fcount", "Число", "Число сессий в фильтре"]]],
];

export function ViewPanel({ v, close }: { v: View; close(): void }) {
  const app = useApp();
  const s = useModule<BoardState>();
  const reset = () => {
    s.setView(VIEW);
    if (app.wide) app.run("card.head.reset");
  };
  return (
    <div className="bd-vw" role="dialog" aria-label="Вид списка" data-hide-tabs="">
      <div className="vw-h">
        <b>Вид списка</b>
        <Btn className="vw-x" data-act="view-reset" onClick={reset}>
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
        {GROUPS.map(([title, units]) => (
          <Choices key={title} title={title}>
            {units.map(([key, label, full]) => (
              <Chip key={key} data-v={key} aria-label={full} on={v[key]} disabled={key === "group" && !v.projects} onClick={() => s.setView({ ...v, [key]: !v[key] })}>
                {label}
              </Chip>
            ))}
          </Choices>
        ))}
        {app.wide && <app.Slot screen="card.view" />}
      </div>
    </div>
  );
}

const FIELDS: Array<[FilterField, string]> = [["who", "Чьи"], ["projects", "Проекты"], ["machines", "Машины"], ["profiles", "Профили"], ["states", "Состояние"]];
const STATES = ["waiting", "busy", "idle", "failed", "stopped"];
type Option = { value: string; text: string };

export function FilterEditor({ filter, close }: { filter: Filter | null; close(): void }) {
  const app = useApp();
  const s = useModule<BoardState>();
  const [draft, setDraft] = useState<Filter>(filter ?? { id: `f${Math.random().toString(36).slice(2, 8)}`, name: "" });
  const [q, setQ] = useState("");
  const options = app.use((): Record<FilterField, Option[]> => {
    const sessions = s.sessions();
    const me = app.address() && userOf(app.address()!);
    const owners = [...new Set(sessions.map((x) => s.owner(x.callsign)))].filter((o): o is string => !!o && o !== me);
    const profiles = [...new Set(sessions.map(profileIdOf))].filter((p): p is string => !!p);
    const machines = [...new Set([...(app.roster()?.machines ?? []).map((m) => m.machine), ...sessions.map((x) => machineOf(x.callsign)!)])];
    return {
      who: [{ value: "mine", text: "моё" }, ...owners.map((o) => ({ value: o, text: o.slice(1) }))],
      projects: (s.records() ?? []).map((r) => ({ value: r.id, text: r.name })),
      machines: machines.map((m) => ({ value: m, text: machineLabel(app, m).text })),
      profiles: profiles.map((p) => ({ value: p, text: profileName(p) })),
      states: STATES.map((x) => ({ value: x, text: stateLabel(x).text })),
    };
  });
  const fit = app.use(() => {
    const list = s.fitting(draft);
    return fitLine(list.length, new Set(list.map((x) => s.projectOf(x.callsign))).size);
  });
  const toggle = (field: FilterField, value: string) => {
    const was = draft[field] ?? [];
    setDraft({ ...draft, [field]: was.includes(value) ? was.filter((x) => x !== value) : [...was, value] });
  };
  const needle = q.trim().toLowerCase();
  const fields = FIELDS.flatMap(([field, title]) => {
    const picked = draft[field] ?? [];
    const list = options[field].filter((o) => picked.includes(o.value) || o.text.toLowerCase().includes(needle));
    return list.length ? [{ field, title, list, picked }] : [];
  });
  const save = () => {
    s.saveFilter({ ...draft, name: draft.name.trim() });
    close();
  };
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
  return (
    <div className="bd-veil" data-editor="1" onClick={(e) => e.target === e.currentTarget && close()} onKeyDown={onKey}>
      <div className="bd-dlg" role="dialog" aria-label="Фильтр">
        <div className="fe-h">
          <b>{filter ? "Фильтр" : "Новый фильтр"}</b>
        </div>
        <div className="fe-b">
          <In className="fe-name" data-f="name" placeholder="Имя фильтра" aria-label="Имя фильтра" autoComplete="off" autoFocus={!filter} value={draft.name} onInput={(e) => setDraft({ ...draft, name: e.currentTarget.value })} />
          <In className="fe-q" data-f="q" placeholder="Найти: люди, проекты, машины…" aria-label="Найти в фильтре" autoComplete="off" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
          <div className="fe-fs">
            {fields.map(({ field, title, list, picked }) => (
              <div key={field} className="fe-f" data-field={field}>
                <div className="fe-l">
                  <b>{title}</b>
                  {picked.length > 0 && <span>{picked.length}</span>}
                </div>
                <Chips className="fe-c">
                  {list.map((o) => (
                    <Chip key={o.value} data-v={o.value} on={picked.includes(o.value)} onClick={() => toggle(field, o.value)}>
                      {o.text}
                    </Chip>
                  ))}
                </Chips>
              </div>
            ))}
            {!fields.length && <div className="fe-none">ничего</div>}
          </div>
        </div>
        <div className="fe-ft">
          <span className="fe-n">{fit}</span>
          {filter && (
            <Btn bad data-act="fdel" onClick={() => (s.removeFilter(filter.id), close())}>
              Удалить
            </Btn>
          )}
          <Btn onClick={close}>Отмена</Btn>
          <Btn pri data-act="fsave" disabled={!draft.name.trim()} onClick={save}>
            Сохранить
          </Btn>
        </div>
      </div>
    </div>
  );
}
