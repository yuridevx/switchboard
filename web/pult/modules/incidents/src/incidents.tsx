// pult-incidents — инциденты: сессии с полем roster incident и недоставленные обращения из журнала машины.
// Своего хранилища нет: сессии — из roster, недоставленные — обращения incident.pending без сессии, причина — machine.journal.
import { memo, useEffect, useState } from "react";
import type { App, AppModule, Roster, SessionRecord } from "@switchboard/web-core";
import type {} from "@switchboard/web-labels";
import { machineOf } from "@switchboard/protocol";
import { Btn, Dot, hhmm, Note, Page, PageHead, stateLabel } from "@switchboard/web-ui";
import css from "./incidents.css";

type Rec = { t: string; kind?: string; ev?: string; word?: string; why?: string; id?: string; callsign?: string };
type Lost = { machine: string; id: string; word: string; why: string; t: string };
type Inc = { type: string; key?: string };

const incOf = (s: SessionRecord): Inc | null => {
  const x = s.incident as Inc | undefined;
  return x && typeof x.type === "string" ? x : null;
};
const open = (s: SessionRecord) => s.state !== "stopped";

/** Полночь сегодня по местному времени — since журнала машины. */
function midnight(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createIncidents(): AppModule {
  let app: App;
  /** недоставленные по машинам: последняя строка отказа на обращение */
  const lost = new Map<string, Lost[]>();
  const refused = new Map<string, string>();
  /** машины, чей журнал уже прочитан: новая в roster — дочитать её */
  const asked = new Set<string>();

  /** Машины с инцидентами и журналом. */
  const machines = () => (app.roster()?.machines ?? []).filter((m) => m.contract?.incident !== undefined && m.contract?.["machine.journal"] !== undefined).map((m) => m.machine);

  async function loadLost(only?: string[]) {
    await Promise.all(
      (only ?? machines()).map(async (m) => {
        asked.add(m);
        const r = await app.request<{ records: Rec[]; more: boolean }>("machine.journal", { machine: m, since: midnight(), kind: ["refuse"], limit: 200 });
        if (!r.ok) return void refused.set(m, r.error);
        refused.delete(m);
        // недоставленные — отказы, чьё обращение ещё на диске без сессии: доставленное потом уходит из списка сразу
        const p = await app.request<{ appeals: Array<{ id: string; callsign: string | null }> }>("incident.pending", { machine: m });
        if (!p.ok) return void refused.set(m, `incident.pending: ${p.error}`);
        const waiting = new Set(p.result.appeals.filter((a) => !a.callsign).map((a) => a.id));
        const byId = new Map<string, Lost>();
        for (const x of r.result.records) if (x.ev === "incident" && x.id && waiting.has(x.id)) byId.set(x.id, { machine: m, id: x.id, word: x.word ?? "", why: x.why ?? "", t: x.t });
        lost.set(m, [...byId.values()].reverse());
      }),
    );
    app.changed();
  }

  const sessions = () => (app.roster()?.sessions ?? []).filter((s) => incOf(s));
  const allLost = () => [...lost.values()].flat();

  /** Строка недоставленного обращения: нажатие раскрывает причину. */
  const LostRow = memo(function LostRow({ x, picked, pick }: { x: Lost; picked: boolean; pick(k: string): void }) {
    const k = `${x.machine}:${x.id}`;
    const name = app.use(() => app.mark("label.machine", x.machine)?.text ?? `@${x.machine}`);
    return (
      <>
        <button className="in-row in-lost" data-lost={k} aria-expanded={picked ? "true" : "false"} onClick={() => pick(k)}>
          <Dot kind="bad" className="d" />
          <span className="g">
            <span className="t1">
              <b>{name}</b>
              <span className="s bad">{x.word}</span>
            </span>
            <span className="t2">{`с ${hhmm(new Date(x.t))}`}</span>
          </span>
        </button>
        {picked ? (
          <div className="in-why" data-why={k}>
            {x.why || x.word}
          </div>
        ) : null}
      </>
    );
  });

  /** Строка инцидента в сессии: читает только свою сессию и свои имена. */
  const SessionRow = memo(function SessionRow({ callsign }: { callsign: string }) {
    const s = app.use(() => sessions().find((x) => x.callsign === callsign));
    const name = app.use(() => app.mark("label.session", callsign)?.text ?? callsign);
    const machine = machineOf(callsign) ?? "";
    const host = app.use(() => app.mark("label.machine", machine)?.text ?? `@${machineOf(callsign)}`);
    if (!s) return null;
    const inc = incOf(s)!;
    const st = s.state === "stopped" ? { text: "закрыт", dot: "stop" } : stateLabel(s.state);
    return (
      <button className="in-row" data-incident={callsign} onClick={() => app.open("card", { callsign })}>
        <Dot kind={st.dot} className="d" />
        <span className="g">
          <span className="t1">
            <b>{inc.type}</b>
            {inc.key !== undefined ? <span className="k">{String(inc.key)}</span> : null}
            <span className="s">{st.text}</span>
          </span>
          <span className="t2">
            <span className="m">{name}</span>
            {` · ${host}`}
          </span>
        </span>
      </button>
    );
  });

  function Incidents() {
    const [all, setAll] = useState(false);
    const [picked, setPicked] = useState("");
    const list = app.use(() => sessions().filter((s) => all || open(s)).map((s) => s.callsign));
    const lo = app.use(allLost);
    const words = app.use(() => [...refused]);
    useEffect(() => void loadLost(), []);
    const pick = (k: string) => setPicked((old) => (old === k ? "" : k));
    return (
      <Page>
        <PageHead title={app.wide ? "Инциденты" : undefined}>
          <Btn data-f="open" aria-pressed={all ? "false" : "true"} onClick={() => setAll(false)}>
            открытые
          </Btn>
          <Btn data-f="all" aria-pressed={all ? "true" : "false"} onClick={() => setAll(true)}>
            все
          </Btn>
        </PageHead>
        {lo.length ? (
          <>
            <div className="in-cap">
              <Dot kind="bad" />
              Не доставлены
            </div>
            <div className="in-list">
              {lo.map((x) => {
                const k = `${x.machine}:${x.id}`;
                return <LostRow key={k} x={x} picked={picked === k} pick={pick} />;
              })}
            </div>
          </>
        ) : null}
        {words.map(([m, w]) => (
          <Note key={m} tone="bad" role="alert">{`${m} · machine.journal: ${w}`}</Note>
        ))}
        <div className="in-cap">В сессиях</div>
        {list.length ? (
          <div className="in-list">
            {list.map((c) => (
              <SessionRow key={c} callsign={c} />
            ))}
          </div>
        ) : (
          <Note>{all ? "Инцидентов нет" : "Открытых инцидентов нет"}</Note>
        )}
      </Page>
    );
  }

  return {
    on: {
      roster(_r: Roster) {
        // машина впервые в roster — её недоставленные для метки раздела; заново — при открытии экрана
        const fresh = machines().filter((m) => !asked.has(m));
        if (fresh.length) void loadLost(fresh);
      },
    },
    screens: {
      incidents: {
        nav: "Инциденты",
        // телефон: во «Флоте»; пульт — отдельный раздел колонки
        narrowGroup: "Флот",
        mark: "incidents.open",
        label: "Инциденты",
        view: Incidents,
        head: () => ({ title: "Инциденты" }),
        find: (q) =>
          sessions()
            .filter((s) => !q || `${incOf(s)!.type} ${incOf(s)!.key ?? ""} ${s.callsign}`.toLowerCase().includes(q))
            .map((s) => ({ label: `${incOf(s)!.type} · ${s.callsign}`, hint: "инцидент", dot: stateLabel(s.state).dot, screen: "incidents", params: {} })),
      },
    },
    marks: {
      "incidents.open": () => sessions().filter(open).length + allLost().length,
    },
    css,
    start(a) {
      app = a;
    },
  };
}
