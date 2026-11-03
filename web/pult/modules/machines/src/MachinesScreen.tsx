// Экран машин: строки, поиск и фильтры. Открыт проект — его машины: фильтр «в проекте» первым.
import { useCallback, useEffect, useState } from "react";
import { useApp } from "@switchboard/web-core";
import { Btn, In, Note, Opts, Page, PageHead } from "@switchboard/web-ui";
import { useMachines } from "./context.ts";
import { MachineRow } from "./MachineRow.tsx";
import { okOf, stateOf } from "./store.ts";

type Filter = "project" | "all" | "fail" | "gone";

export function MachinesScreen() {
  const app = useApp();
  const machines = useMachines();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>(() => (app.mark("project.current") ? "project" : "all"));
  const [open, setOpen] = useState<string | null>(null);
  const toggle = useCallback((m: string) => setOpen((old) => (old === m ? null : m)), []);
  const states = app.use(machines.states);
  const gone = app.use(machines.gone);
  const names = app.use(() => (app.roster()?.machines ?? []).map((m) => m.machine));
  const proj = app.use(() => app.mark("project.current"));
  const pm = app.use(() => (proj ? (app.mark("project.machines", proj) ?? []) : []));
  useEffect(() => machines.mount(), [machines]);
  // проект закрыт — фильтра по нему нет: поправка состояния при рисовании
  if (filter === "project" && !proj) setFilter("all");
  const all = [...new Set([...names, ...Object.keys(gone)])];
  const F: Record<Filter, [string, (m: string) => boolean]> = {
    project: [proj ? `в проекте ${proj}` : "", (m) => pm.includes(m)],
    all: ["все", () => true],
    fail: ["со сбоем", (m) => stateOf(m, states, gone) === "fail"],
    gone: ["ушли", (m) => stateOf(m, states, gone) === "gone"],
  };
  const t = q.trim().toLowerCase();
  const shown = all.filter((m) => F[filter][1](m) && (!t || m.toLowerCase().includes(t) || okOf(states[m])?.os?.toLowerCase().includes(t)));
  return (
    <Page>
      <PageHead>
        <In data-f="q" type="search" placeholder="Найти машину" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
        <Opts>
          {(Object.keys(F) as Filter[])
            .filter((k) => k !== "project" || !!proj)
            .map((k) => (
              <Btn key={k} data-filter={k} aria-pressed={filter === k ? "true" : "false"} onClick={() => setFilter(k)}>
                {`${F[k][0]} ${all.filter(F[k][1]).length}`}
              </Btn>
            ))}
        </Opts>
      </PageHead>
      {shown.length ? (
        <div className="mc-list">
          {shown.map((m) => (
            <MachineRow key={m} m={m} open={open === m} toggle={toggle} />
          ))}
        </div>
      ) : (
        <Note>Таких машин нет</Note>
      )}
    </Page>
  );
}
