// Окно фильтра: имя, одна строка поиска на все поля, поля «Чьи · Проекты · Машины · Профили · Состояние». Совпадения поиска — в каждом поле;
// выбранное видно всегда; поле без совпадений свёрнуто. Снизу — сколько подходит. Хранит список store, здесь — только правка копии.
import { useState } from "react";
import { Btn, plural, profileNameOf, stateLabel, useApp } from "@switchboard/web-ui";
import { machineOf } from "@switchboard/protocol";
import { useBoard } from "./store.ts";
import type { BoardStore } from "./store.ts";
import { FIELDS, type Field, type Filter } from "./rules.ts";

const STATES: Array<[string, string]> = ["waiting", "busy", "idle", "failed", "stopped"].map((k) => [k, stateLabel(k).text]);

/** Варианты поля: значение и подпись. */
function options(board: BoardStore, k: Field): Array<[string, string]> {
  const uniq = (xs: Array<string | undefined>) => [...new Set(xs.filter((x): x is string => !!x))].sort();
  if (k === "who") return [["mine", "моё"], ...board.owners().map((o): [string, string] => [o, o.slice(1)])];
  if (k === "projects") return board.projectOptions();
  if (k === "machines") return uniq([...board.machines(), ...board.sessions().map((s) => machineOf(s.callsign) ?? "")]).map((m) => [m, board.mName(m)]);
  if (k === "profiles") return uniq(board.sessions().map(profileNameOf)).map((x) => [x, x]);
  return STATES;
}

/** Окно фильтра: base — правка своего, null — новый. */
export function FilterEditor({ base, close }: { base: Filter | null; close(): void }) {
  const app = useApp();
  const board = useBoard();
  const [f, setF] = useState<Filter>(() => ({ id: base?.id ?? "", name: base?.name ?? "", who: [...(base?.who ?? [])], projects: [...(base?.projects ?? [])], machines: [...(base?.machines ?? [])], profiles: [...(base?.profiles ?? [])], states: [...(base?.states ?? [])] }));
  const [q, setQ] = useState("");

  function saveClean() {
    const clean: Filter = { id: f.id || `f${Date.now().toString(36)}`, name: f.name.trim() };
    for (const [k] of FIELDS) if (f[k]?.length) clean[k] = f[k];
    board.saveFilter(clean);
    close();
  }

  const ql = q.trim().toLowerCase();
  // выборка: сессии меняют состояние и пока окно открыто — число и варианты не устаревают
  const { n, np, fields } = app.use(() => {
    const hit = board.sessions().filter((s) => board.fits(f, s));
    return {
      n: hit.length,
      np: new Set(hit.map((s) => board.projectId(s.callsign))).size,
      fields: FIELDS.map(([k, label]) => {
        const sel = f[k] ?? [];
        const shown = options(board, k).filter(([v, l]) => sel.includes(v) || !ql || l.toLowerCase().includes(ql));
        return { k, label, sel, shown, found: shown.filter(([v]) => !sel.includes(v)).length };
      }),
    };
  });
  const found = fields.reduce((n, x) => n + x.found, 0);

  return (
    <div className="bd-veil" data-editor="1" onClick={(e) => e.target === e.currentTarget && close()} onKeyDown={(e) => e.key === "Escape" && close()}>
      <div className="bd-dlg" role="dialog" aria-label="Фильтр">
        <div className="fe-h">
          <b>{base ? "Фильтр" : "Новый фильтр"}</b>
        </div>
        <div className="fe-b">
          <input autoFocus={!base} className="fe-name" data-f="name" value={f.name} placeholder="Имя фильтра" autoComplete="off" aria-label="Имя фильтра" onInput={(e) => setF({ ...f, name: e.currentTarget.value })} />
          <input className="fe-q" data-f="q" value={q} placeholder="Найти: люди, проекты, машины…" autoComplete="off" aria-label="Найти в фильтре" onInput={(e) => setQ(e.currentTarget.value)} />
          <div className="fe-fs">
            {fields
              .filter((x) => !ql || x.shown.length)
              .map(({ k, label, sel, shown }) => (
                <div key={k} className="fe-f" data-field={k}>
                  <div className="fe-l">
                    <b>{label}</b>
                    {sel.length ? <span>{String(sel.length)}</span> : null}
                  </div>
                  <div className="fe-c">
                    {shown.map(([v, l]) => (
                      <button key={v} aria-pressed={String(sel.includes(v)) as "true" | "false"} data-v={v} onClick={() => setF({ ...f, [k]: sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v] })}>
                        {l}
                      </button>
                    ))}
                  </div>
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
          <Btn pri data-act="fsave" disabled={!f.name.trim()} onClick={saveClean}>
            Сохранить
          </Btn>
        </div>
      </div>
    </div>
  );
}
