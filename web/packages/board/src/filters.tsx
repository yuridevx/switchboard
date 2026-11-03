// Окно фильтра: имя, одна строка поиска на все поля, поля «Чьи · Проекты · Машины · Профили · Состояние». Совпадения поиска — в каждом поле;
// выбранное видно всегда; поле без совпадений свёрнуто. Снизу — сколько подходит. Хранит список модуль, здесь — только правка копии.
import { useEffect, useRef, useState } from "react";
import type { SessionRecord } from "@switchboard/web-core";
import { Btn, plural } from "@switchboard/web-ui";
import { machineOf } from "@switchboard/protocol";
import { FIELDS, profileOf, type Field, type Filter } from "./rules.ts";

const STATES: Array<[string, string]> = [
  ["waiting", "ждёт вас"],
  ["busy", "работает"],
  ["idle", "свободна"],
  ["failed", "не запустилась"],
  ["stopped", "остановлена"],
];

export type EditorCtx = {
  sessions(): SessionRecord[];
  /** проекты: номер и имя */
  projects(): Array<[string, string]>;
  projectId(callsign: string): string;
  machines(): string[];
  mName(machine: string): string;
  owners(): string[];
  match(f: Filter, s: SessionRecord): boolean;
};

/** Варианты поля: значение и подпись. */
function options(ctx: EditorCtx, k: Field): Array<[string, string]> {
  const uniq = (xs: Array<string | undefined>) => [...new Set(xs.filter((x): x is string => !!x))].sort();
  if (k === "who") return [["mine", "моё"], ...ctx.owners().map((o): [string, string] => [o, o.slice(1)])];
  if (k === "projects") return ctx.projects();
  if (k === "machines") return uniq([...ctx.machines(), ...ctx.sessions().map((s) => machineOf(s.callsign) ?? "")]).map((m) => [m, ctx.mName(m)]);
  if (k === "profiles") return uniq(ctx.sessions().map(profileOf)).map((x) => [x, x]);
  return STATES;
}

/** Окно фильтра: base — правка своего, null — новый; save и remove закрывают сами. */
export function FilterEditor({ ctx, base, save, remove, close }: { ctx: EditorCtx; base: Filter | null; save(f: Filter): void; remove(id: string): void; close(): void }) {
  const [f, setF] = useState<Filter>(() => ({ id: base?.id ?? "", name: base?.name ?? "", who: [...(base?.who ?? [])], projects: [...(base?.projects ?? [])], machines: [...(base?.machines ?? [])], profiles: [...(base?.profiles ?? [])], states: [...(base?.states ?? [])] }));
  const [q, setQ] = useState("");
  const name = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!base) name.current?.focus();
  }, [base]);

  function saveClean() {
    const clean: Filter = { id: f.id || `f${Date.now().toString(36)}`, name: f.name.trim() };
    for (const [k] of FIELDS) if (f[k]?.length) clean[k] = f[k];
    save(clean);
  }

  const hit = ctx.sessions().filter((s) => ctx.match(f, s));
  const np = new Set(hit.map((s) => ctx.projectId(s.callsign))).size;
  const ql = q.trim().toLowerCase();
  const fields = FIELDS.map(([k, label]) => {
    const sel = f[k] ?? [];
    const shown = options(ctx, k).filter(([v, l]) => sel.includes(v) || !ql || l.toLowerCase().includes(ql));
    return { k, label, sel, shown, found: shown.filter(([v]) => !sel.includes(v)).length };
  });
  const found = fields.reduce((n, x) => n + x.found, 0);

  return (
    <div className="bd-veil" data-editor="1" onClick={(e) => e.target === e.currentTarget && close()} onKeyDown={(e) => e.key === "Escape" && close()}>
      <div className="bd-dlg" role="dialog" aria-label="Фильтр">
        <div className="fe-h">
          <b>{base ? "Фильтр" : "Новый фильтр"}</b>
        </div>
        <div className="fe-b">
          <input ref={name} className="fe-name" data-f="name" defaultValue={f.name} placeholder="Имя фильтра" autoComplete="off" aria-label="Имя фильтра" onInput={(e) => setF({ ...f, name: e.currentTarget.value })} />
          <input className="fe-q" data-f="q" placeholder="Найти: люди, проекты, машины…" autoComplete="off" aria-label="Найти в фильтре" onInput={(e) => setQ(e.currentTarget.value)} />
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
          <span className="fe-n">{`подходит ${hit.length} ${plural(hit.length, "сессия", "сессии", "сессий")} · ${np} ${plural(np, "проект", "проекта", "проектов")}`}</span>
          {base ? (
            <Btn bad data-act="fdel" onClick={() => remove(f.id)}>
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
