// pult-machines — машины флота строками: лампа, имя, система, host, keeper, сессии, состояние; поиск и фильтры.
// Строка раскрывается в карточку: части по ответу keeper (keeper.state), перезапуск упавшей части планом.
// Каждая цифра — ответ keeper, машины или roster. Ушедшую машину помнит, пока страница открыта: roster её больше не несёт.
import { memo, useEffect, useState } from "react";
import type { App, AppModule, Roster } from "@switchboard/web-core";
import type {} from "@switchboard/web-board";
import type {} from "@switchboard/web-labels";
import { machineOf } from "@switchboard/protocol";
import { Btn, Dot, hhmm, In, Note, Opts, Page, PageHead, plural } from "@switchboard/web-ui";
import css from "./machines.css";

type Part = { part: string; version?: string; state?: string; pid?: number; restarts?: number; error?: string };
type State = { keeper?: string; rev?: number; os?: string; parts?: Part[] };
/** Состояние строки: на связи, сбой части, ушла. */
type Mst = "ok" | "fail" | "gone";
type Filter = "project" | "all" | "fail" | "gone";

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createMachines(): AppModule {
  let app: App;
  const states = new Map<string, State | { error: string }>();
  const notes = new Map<string, { text: string; tone: "ok" | "bad" | "wait" | undefined }>();
  /** since машины в последнем roster: вернулась — keeper спрашиваем заново */
  const seen = new Map<string, number>();
  /** машина ушла из roster, пока страница открыта: когда */
  const gone = new Map<string, number>();
  /** сколько экранов открыто: при открытом экране вернувшейся машине спрашиваем keeper */
  let opened = 0;
  /** номер изменения данных модуля: их читает список экрана */
  let rev = 0;
  const redraw = () => {
    rev++;
    app.changed();
  };

  const note = (k: string, text: string, tone?: "ok" | "bad") => {
    notes.set(k, { text, tone });
    redraw();
  };

  async function load(m: string) {
    const jobs: Array<Promise<void>> = [];
    // keeper машины отвечает сам, даже когда Host мёртв
    jobs.push(app.request<State>("keeper.state", { to: `.keeper@${m}` }).then((r) => void states.set(m, r.ok ? r.result : { error: r.error })));
    await Promise.all(jobs);
    redraw();
  }

  function onRoster(r: Roster) {
    const now = new Set(r.machines.map((m) => m.machine));
    for (const m of seen.keys()) if (!now.has(m) && !gone.has(m)) gone.set(m, Date.now());
    for (const m of r.machines) {
      gone.delete(m.machine);
      // вернулась (since другой) или впервые появилась — при открытом экране спросить её keeper и профили
      if (opened > 0 && seen.get(m.machine) !== m.since) void load(m.machine);
      seen.set(m.machine, m.since);
    }
    redraw();
  }

  /** Перезапуск упавшей части — планом машины: выключить и включить; keeper исполняет. */
  async function restart(m: string, part: string) {
    note(`part:${m}:${part}`, "Перезапускаю…");
    const off = await app.request("releases.set", { machine: m, part, on: false });
    if (!off.ok) return note(`part:${m}:${part}`, `releases.set: ${off.error}`, "bad");
    const on = await app.request("releases.set", { machine: m, part, on: true });
    if (!on.ok) return note(`part:${m}:${part}`, `releases.set: ${on.error}`, "bad");
    note(`part:${m}:${part}`, "выключена и включена по плану", "ok");
    void load(m);
  }

  /** Ответ keeper машины, если он без отказа. */
  function okOf(m: string): State | null {
    const st = states.get(m);
    return st && !("error" in st) ? st : null;
  }

  function stateOf(m: string): Mst {
    if (gone.has(m)) return "gone";
    return (okOf(m)?.parts ?? []).some((p) => p.state === "failed") ? "fail" : "ok";
  }

  /** Строка части: перезапуск упавшей и строка его итога. */
  function PartRow({ m, p }: { m: string; p: Part }) {
    const k = `part:${m}:${p.part}`;
    const n = app.use(() => notes.get(k) ?? null);
    return (
      <div className="mc-part">
        <Dot kind={p.state === "running" ? "idle" : p.state === "failed" ? "bad" : "stop"} />
        <span>
          <b>{p.part}</b>{" "}
          <span className={p.state === "failed" ? "v bad" : "v"} data-part={p.part} data-state={p.state ?? ""}>
            {[p.version, p.state, p.pid ? `pid ${p.pid}` : ""].filter(Boolean).join(" · ")}
          </span>
          {p.error ? <div className="e">{p.error}</div> : null}
        </span>
        {p.state === "failed" && p.part !== "keeper" && app.worker("releases") ? (
          <Btn className="r" onClick={() => void restart(m, p.part)}>
            Перезапустить
          </Btn>
        ) : null}
        {n?.text ? (
          <Note tone={n.tone} role="status">
            {n.text}
          </Note>
        ) : null}
      </div>
    );
  }

  /** Карточка машины: система, keeper, части и переходы. */
  function Detail({ m }: { m: string }) {
    const st = app.use(() => states.get(m) ?? null);
    const on = app.use(() => !gone.has(m));
    const login = app.use(() => app.can(m, "machine.login"));
    const ok = st && !("error" in st) ? st : null;
    return (
      <div className="mc-det" data-machine={m}>
        {ok ? (
          <div className="mc-kv">
            <span>система</span>
            <span>{ok.os ?? "?"}</span>
            <span>keeper</span>
            <span data-keeper={ok.keeper ?? ""}>{`${ok.keeper ?? "?"} · план rev ${ok.rev ?? 0}`}</span>
          </div>
        ) : st && "error" in st ? (
          <Note tone="bad">{`keeper.state: ${st.error}`}</Note>
        ) : on ? (
          <Note>…</Note>
        ) : null}
        {ok ? (
          <div className="mc-parts">
            {(ok.parts ?? []).map((p) => (
              <PartRow key={p.part} m={m} p={p} />
            ))}
          </div>
        ) : null}
        {on ? (
          <Opts>
            {login ? <Btn onClick={() => app.open("accounts", { machine: m })}>Аккаунты машины</Btn> : null}
            {app.wide ? <Btn onClick={() => app.open("settings", { tab: "releases", machine: m })}>План в «Выпусках»</Btn> : null}
          </Opts>
        ) : null}
      </div>
    );
  }

  /** Строка машины: читает только своё; изменилась другая машина — эта не перерисовывается. */
  const Row = memo(function Row({ m, open, toggle }: { m: string; open: boolean; toggle(m: string): void }) {
    const d = app.use(() => {
      const ok = okOf(m);
      return {
        st: stateOf(m),
        os: ok?.os ?? "",
        host: ok?.parts?.find((p) => p.part === "host")?.version,
        keeper: ok?.keeper,
        at: gone.get(m) ?? 0,
        n: (app.roster()?.sessions ?? []).filter((s) => machineOf(s.callsign) === m).length,
        name: app.mark("label.machine", m)?.text ?? `@${m}`,
      };
    });
    const text = d.st === "gone" ? `ушла ${hhmm(d.at)}` : d.st === "fail" ? "сбой части" : "на связи";
    return (
      <>
        <div className="mc-row" data-row={m} data-state={d.st}>
          <button className="mc-head" aria-expanded={open ? "true" : "false"} onClick={() => toggle(m)}>
            <Dot kind={d.st === "ok" ? "idle" : d.st === "gone" ? "gone" : "bad"} />
            <span className="n">{d.name}</span>
            <span className="os">{d.os}</span>
            <span className="v">{d.host ? `host ${d.host}` : ""}</span>
            <span className="v">{d.keeper ? `keeper ${d.keeper}` : ""}</span>
            <span className="st">{[d.n ? `${d.n} ${plural(d.n, "сессия", "сессии", "сессий")}` : "", text].filter(Boolean).join(" · ")}</span>
          </button>
        </div>
        {open ? <Detail m={m} /> : null}
      </>
    );
  });

  function Machines() {
    const [q, setQ] = useState("");
    const [filter, setFilter] = useState<Filter>(() => (app.mark("project.current") ? "project" : "all"));
    const [open, setOpen] = useState<string | null>(null);
    const [toggle] = useState(() => (m: string) => setOpen((old) => (old === m ? null : m)));
    // фильтры считают состояние всех машин: список перечитывается на каждое изменение данных модуля
    app.use(() => rev);
    const names = app.use(() => (app.roster()?.machines ?? []).map((m) => m.machine));
    // открыт проект — его машины: фильтр «в проекте» первым
    const proj = app.use(() => app.mark("project.current"));
    const pm = app.use(() => (proj ? (app.mark("project.machines", proj) ?? []) : []));
    useEffect(() => {
      opened++;
      for (const m of app.roster()?.machines ?? []) void load(m.machine);
      return () => void opened--;
    }, []);
    if (filter === "project" && !proj) setFilter("all");
    const all = [...new Set([...names, ...gone.keys()])];
    const F: Record<Filter, [string, (m: string) => boolean]> = {
      project: [proj ? `в проекте ${proj}` : "", (m) => pm.includes(m)],
      all: ["все", () => true],
      fail: ["со сбоем", (m) => stateOf(m) === "fail"],
      gone: ["ушли", (m) => stateOf(m) === "gone"],
    };
    const t = q.trim().toLowerCase();
    const shown = all.filter((m) => F[filter][1](m) && (!t || m.toLowerCase().includes(t) || okOf(m)?.os?.toLowerCase().includes(t)));
    return (
      <Page>
        <PageHead>
          <In data-f="q" type="search" placeholder="Найти машину" onInput={(e) => setQ(e.currentTarget.value)} />
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
              <Row key={m} m={m} open={open === m} toggle={toggle} />
            ))}
          </div>
        ) : (
          <Note>Таких машин нет</Note>
        )}
      </Page>
    );
  }

  return {
    on: { roster: onRoster },
    screens: { machines: { nav: "Машины", group: "Флот", label: "Машины", view: Machines, head: () => ({ title: "Машины" }) } },
    css,
    start(a) {
      app = a;
    },
  };
}
