// Окно фильтра: имя, одна строка поиска на все поля, поля «Чьи · Проекты · Машины · Профили · Состояние». Совпадения поиска — в каждом поле;
// выбранное видно всегда; поле без совпадений свёрнуто. Снизу — сколько подходит. Хранит список состояние, здесь — только правка копии.
import { useState } from "react";
import { Btn, Chip, Chips, In, plural, profileNameOf, stateLabel, useApp } from "@switchboard/web-ui";
import { machineOf } from "@switchboard/protocol";
import { FIELDS, type Field, type Filter } from "./rules.ts";
import { useBoard, type BoardState } from "./state.ts";

const STATES: Array<[string, string]> = ["waiting", "busy", "idle", "failed", "stopped"].map((k) => [k, stateLabel(k).text]);

/** Варианты поля: значение и подпись. */
function options(board: BoardState, k: Field): Array<[string, string]> {
  const uniq = (xs: Array<string | undefined>) => [...new Set(xs.filter((x): x is string => !!x))].sort();
  switch (k) {
    case "who":
      return [["mine", "моё"], ...board.owners().map((o): [string, string] => [o, o.slice(1)])];
    case "projects":
      return board.projectOptions();
    case "machines":
      return uniq([...board.machines(), ...board.sessions().map((s) => machineOf(s.callsign) ?? "")]).map((m) => [m, board.mName(m)]);
    case "profiles":
      return uniq(board.sessions().map(profileNameOf)).map((x) => [x, x]);
    default:
      return STATES;
  }
}

/** Окно фильтра: base — правка своего, null — новый. */
export function FilterEditor({ base, close }: { base: Filter | null; close(): void }) {
  const app = useApp();
  const board = useBoard();
  const [f, setF] = useState<Filter>(() => ({ id: base?.id ?? "", name: base?.name ?? "", who: [...(base?.who ?? [])], projects: [...(base?.projects ?? [])], machines: [...(base?.machines ?? [])], profiles: [...(base?.profiles ?? [])], states: [...(base?.states ?? [])] }));
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();

  // выборка: сессии меняют состояние и пока окно открыто — число и варианты не устаревают
  const { n, np, fields } = app.use(() => {
    const hit = board.sessions().filter((s) => board.fits(f, s));
    return {
      n: hit.length,
      np: new Set(hit.map((s) => board.projectId(s.callsign))).size,
      fields: FIELDS.map(([k, label]) => {
        const sel = f[k] ?? [];
        return { k, label, sel, shown: options(board, k).filter(([v, l]) => sel.includes(v) || !ql || l.toLowerCase().includes(ql)) };
      }),
    };
  });
  const found = fields.some((x) => x.shown.some(([v]) => !x.sel.includes(v)));

  function save() {
    const clean: Filter = { id: f.id || `f${Date.now().toString(36)}`, name: f.name.trim() };
    for (const [k] of FIELDS) if (f[k]?.length) clean[k] = f[k];
    board.saveFilter(clean);
    close();
  }

  return (
    <div className="bd-veil" data-editor="1" onClick={(e) => e.target === e.currentTarget && close()} onKeyDown={(e) => e.key === "Escape" && close()}>
      <div className="bd-dlg" role="dialog" aria-label="Фильтр">
        <div className="fe-h">
          <b>{base ? "Фильтр" : "Новый фильтр"}</b>
        </div>
        <div className="fe-b">
          <In autoFocus={!base} className="fe-name" data-f="name" value={f.name} placeholder="Имя фильтра" autoComplete="off" aria-label="Имя фильтра" onInput={(e) => setF({ ...f, name: e.currentTarget.value })} />
          <In className="fe-q" data-f="q" value={q} placeholder="Найти: люди, проекты, машины…" autoComplete="off" aria-label="Найти в фильтре" onInput={(e) => setQ(e.currentTarget.value)} />
          <div className="fe-fs">
            {fields
              .filter((x) => !ql || x.shown.length)
              .map(({ k, label, sel, shown }) => (
                <div key={k} className="fe-f" data-field={k}>
                  <div className="fe-l">
                    <b>{label}</b>
                    {sel.length ? <span>{String(sel.length)}</span> : null}
                  </div>
                  <Chips className="fe-c">
                    {shown.map(([v, l]) => (
                      <Chip key={v} on={sel.includes(v)} data-v={v} onClick={() => setF({ ...f, [k]: sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v] })}>
                        {l}
                      </Chip>
                    ))}
                  </Chips>
                </div>
              ))}
            {ql && !found ? <div className="fe-none">ничего</div> : null}
          </div>
        </div>
        <div className="fe-ft">
          <span className="fe-n">{`подходит ${n} ${plural(n, "сессия", "сессии", "сессий")} · ${np} ${plural(np, "проект", "проекта", "проектов")}`}</span>
          {base ? (
            <Btn
              bad
              data-act="fdel"
              onClick={() => {
                board.removeFilter(f.id);
                close();
              }}
            >
              Удалить
            </Btn>
          ) : null}
          <Btn onClick={close}>Отмена</Btn>
          <Btn pri data-act="fsave" disabled={!f.name.trim()} onClick={save}>
            Сохранить
          </Btn>
        </div>
      </div>
    </div>
  );
}
