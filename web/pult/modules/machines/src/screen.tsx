// Экран «Машины»: строки с поиском и фильтрами; строка раскрывается в карточку с частями. Ответы keeper'ов читает у настроек.
import { useEffect, useRef, useState } from "react";
import { Btn, DisclosureBtn, Dot, hhmm, In, machineLabel, machinesWith, Note, okOf, Opts, Outcome, Page, PageHead, plural, useApp, useModule, useOutcome, wordOf } from "@switchboard/web-ui";
import type { KeeperAnswers, KeeperPart } from "../../settings/contract.ts";
import type { MachinesState } from "./module.tsx";

const STATE_DOT: Record<string, string> = { running: "idle", failed: "bad" };
const partText = (p: KeeperPart) => [p.version, p.state, p.pid ? `pid ${p.pid}` : ""].filter(Boolean).join(" · ");

export function MachinesScreen() {
  const app = useApp();
  const state = useModule<MachinesState>();
  const { seen, gone } = app.use(() => state.get());
  const online = app.use(() => machinesWith(app));
  const answers = app.use(() => (app.mark("keeper.answers") as KeeperAnswers | undefined)?.get() ?? {});
  const project = app.use(() => app.mark("project.current") as string | null | undefined);
  const near = app.use(() => (project ? ((app.mark("project.machines", project) as string[] | undefined) ?? []) : []));
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const running = useRef(new Set<string>());
  const [notes, say] = useOutcome();

  useEffect(() => {
    app.run("keeper.open");
    return () => app.run("keeper.close");
    // экран открыт — ответы свежие; app один на модуль
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const names = [...online, ...Object.keys(gone).filter((m) => !online.includes(m))];
  const failing = (m: string) => (okOf(answers[m])?.parts ?? []).some((p) => p.state === "failed");
  const count = { fail: names.filter(failing).length, gone: names.filter((m) => gone[m] !== undefined).length };
  // открытый проект сужает сразу; проекта нет — все
  const filterNow = !near.length && (filter ?? "project") === "project" ? "all" : (filter ?? "project");
  const needle = q.trim().toLowerCase();
  const rows = names.filter((m) => {
    const ok = filterNow === "fail" ? failing(m) : filterNow === "gone" ? gone[m] !== undefined : filterNow === "project" ? near.includes(m) : true;
    return ok && (!needle || `${m} ${machineLabel(app, m).text} ${okOf(answers[m])?.os ?? ""}`.toLowerCase().includes(needle));
  });

  async function restart(machine: string, part: string) {
    const key = `${machine}:${part}`;
    if (running.current.has(key)) return;
    running.current.add(key);
    say(key, "Перезапускаю…");
    for (const on of [false, true]) {
      const r = await app.request("releases.set", { machine, part, on });
      if (!r.ok) {
        running.current.delete(key);
        say(key, `releases.set: ${r.error}`, "bad");
        return;
      }
    }
    running.current.delete(key);
    say(key, "выключена и включена по плану", "ok");
    app.run("keeper.reload", { machine });
  }

  const filterBtn = (id: string, text: string) => (
    <Btn key={id} aria-pressed={filterNow === id ? "true" : "false"} data-filter={id} onClick={() => setFilter(id)}>
      {text}
    </Btn>
  );

  return (
    <Page>
      <PageHead>
        <In type="search" data-f="q" placeholder="Найти машину" value={q} onChange={() => {}} onInput={(e) => setQ(e.currentTarget.value)} />
        <Opts>
          {near.length ? filterBtn("project", `в проекте ${project} ${near.length}`) : null}
          {filterBtn("all", `все ${names.length}`)}
          {filterBtn("fail", `со сбоем ${count.fail}`)}
          {filterBtn("gone", `ушли ${count.gone}`)}
        </Opts>
      </PageHead>
      {rows.length ? (
        <div className="mc-list">
          {rows.map((m) => {
            const answer = okOf(answers[m]);
            const word = wordOf(answers[m]);
            const left = gone[m];
            const fail = failing(m);
            const rowState = left !== undefined ? "gone" : fail ? "fail" : "ok";
            const n = seen[m] ?? 0;
            const parts = answer?.parts ?? [];
            const host = parts.find((p) => p.part === "host");
            return [
              <div key={m} className="mc-row" data-row={m} data-state={rowState}>
                <DisclosureBtn open={!!open[m]} className="mc-head" onClick={() => setOpen({ ...open, [m]: !open[m] })}>
                  <Dot kind={rowState === "gone" ? "gone" : fail ? "bad" : "idle"} />
                  <span className="n">{machineLabel(app, m).text}</span>
                  <span className="os">{answer?.os}</span>
                  <span className="v">{host ? `host ${host.version}` : ""}</span>
                  <span className="v">{answer?.keeper ? `keeper ${answer.keeper}` : ""}</span>
                  <span className="st">{`${n} ${plural(n, "сессия", "сессии", "сессий")} · ${left !== undefined ? `ушла ${hhmm(left)}` : fail ? "сбой части" : "на связи"}`}</span>
                </DisclosureBtn>
              </div>,
              open[m] ? (
                <div key={`${m}:det`} className="mc-det" data-machine={m}>
                  {answer ? (
                    <div className="mc-kv">
                      <span>система</span>
                      <span>{answer.os}</span>
                      <span>keeper</span>
                      <span data-keeper={answer.keeper}>{`${answer.keeper} · план rev ${answer.rev}`}</span>
                    </div>
                  ) : null}
                  {word ? <Note tone="bad">{`keeper.state: ${word}`}</Note> : null}
                  {!answer && !word ? <Note>…</Note> : null}
                  {answer ? <div className="mc-parts">
                    {parts.map((p) => {
                      const key = `${m}:${p.part}`;
                      return (
                        <div key={p.part} className="mc-part">
                          <Dot kind={STATE_DOT[p.state] ?? "stop"} />
                          <span>
                            <b>{p.part}</b> <span className={p.state === "failed" ? "v bad" : "v"} data-part={p.part} data-state={p.state}>{partText(p)}</span>
                            {p.error ? <div className="e">{p.error}</div> : null}
                          </span>
                          {p.state === "failed" && p.part !== "keeper" ? (
                            <Btn className="r" onClick={() => void restart(m, p.part)}>
                              Перезапустить
                            </Btn>
                          ) : null}
                          <Outcome note={notes[key]} />
                        </div>
                      );
                    })}
                  </div> : null}
                  <Opts>
                    <Btn onClick={() => app.open("accounts", { machine: m })}>Аккаунты машины</Btn>
                    {app.wide ? <Btn onClick={() => app.open("settings", { tab: "releases", machine: m })}>План в «Выпусках»</Btn> : null}
                  </Opts>
                </div>
              ) : null,
            ];
          })}
        </div>
      ) : (
        <Note>Таких машин нет</Note>
      )}
    </Page>
  );
}
