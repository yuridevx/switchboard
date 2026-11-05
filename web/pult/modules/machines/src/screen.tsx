// Экран машин: строки, поиск и фильтры. Открыт проект — его машины: фильтр «в проекте» первым.
import { useCallback, useEffect, useState } from "react";
import { Btn, In, machinesWith, Note, okOf, Opts, Page, PageHead, useApp } from "@switchboard/web-ui";
import { MachineRow } from "./row.tsx";
import { conditionOf, useMachines } from "./state.ts";

type Filter = "project" | "all" | "fail" | "gone";

export function MachinesScreen() {
  const app = useApp();
  const machines = useMachines();
  const [q, setQ] = useState("");
  const [chosen, setFilter] = useState<Filter>(() => (app.mark("project.current") ? "project" : "all"));
  const [open, setOpen] = useState<string | null>(null);
  const toggle = useCallback((m: string) => setOpen((old) => (old === m ? null : m)), []);
  const answers = app.use(machines.answers);
  const gone = app.use(machines.gone);
  const names = app.use(() => machinesWith(app));
  const project = app.use(() => app.mark("project.current"));
  const inProject = app.use(() => (project ? (app.mark("project.machines", project) ?? []) : []));
  useEffect(() => machines.mount(), [machines]);

  // проект закрыт — фильтра по нему нет; проект открылся снова — фильтр вернулся
  const filter = chosen === "project" && !project ? "all" : chosen;
  const all = [...new Set([...names, ...Object.keys(gone)])];
  const filters: Record<Filter, [string, (m: string) => boolean]> = {
    project: [project ? `в проекте ${project}` : "", (m) => inProject.includes(m)],
    all: ["все", () => true],
    fail: ["со сбоем", (m) => conditionOf(m, answers, gone) === "fail"],
    gone: ["ушли", (m) => conditionOf(m, answers, gone) === "gone"],
  };
  const t = q.trim().toLowerCase();
  const shown = all.filter((m) => filters[filter][1](m) && (!t || m.toLowerCase().includes(t) || okOf(answers[m])?.os?.toLowerCase().includes(t)));
  return (
    <Page>
      <PageHead>
        <In data-f="q" type="search" placeholder="Найти машину" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
        <Opts>
          {(Object.keys(filters) as Filter[])
            .filter((k) => k !== "project" || !!project)
            .map((k) => (
              <Btn key={k} data-filter={k} aria-pressed={filter === k ? "true" : "false"} onClick={() => setFilter(k)}>
                {`${filters[k][0]} ${all.filter(filters[k][1]).length}`}
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
