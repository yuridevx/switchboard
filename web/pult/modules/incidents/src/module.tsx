// pult-incidents: инциденты флота — сессии с полем roster incident и обращения на диске Host без сессии (incident.pending).
import { Fragment, useEffect, useState } from "react";
import type { Roster } from "@switchboard/relay";
import type { AppModule } from "@switchboard/web-core";
import {
  Btn,
  day,
  DisclosureBtn,
  Dot,
  hhmm,
  incidentOf,
  lamp,
  machineAnswers,
  machineLabel,
  machinesWith,
  Note,
  okOf,
  Page,
  PageHead,
  sessionLabel,
  stateLabel,
  useApp,
  useModule,
  wordOf,
  type App,
} from "@switchboard/web-ui";
import css from "./incidents.css";

type Appeal = { id: string; type?: string; key?: string | null; callsign: string | null; refused?: { word: string; why: string; t: string } | null };
type Lost = Appeal & { machine: string };
type Row = { callsign: string; state: string; type: string; key?: string; dot: string };

function createState(app: App) {
  const answers = machineAnswers<{ appeals: Appeal[] }>(app, (machine) => app.read("incident.pending", { machine }), () => machinesWith(app, "incident"));
  const asked = new Set<string>();

  /** Сессии инцидентов из roster: тип, ключ, состояние. */
  const rows = (): Row[] =>
    (app.roster()?.sessions ?? []).flatMap((s) => {
      const i = incidentOf(s);
      return i?.type ? [{ callsign: s.callsign, state: String(s.state), type: i.type, ...(i.key ? { key: i.key } : {}), dot: lamp(s) }] : [];
    });
  /** Обращения без сессии; новые сверху. */
  const lost = (): Lost[] =>
    Object.entries(answers.get()).flatMap(([machine, a]) =>
      (okOf(a)?.appeals ?? [])
        .filter((x) => !x.callsign)
        .reverse()
        .map((x) => ({ ...x, machine })),
    );
  const open = () => rows().filter((r) => r.state !== "stopped").length + lost().length;

  /** Метке нужен список с первого roster: новые машины спрашиваются по одной. */
  function onRoster(_r: Roster) {
    for (const m of machinesWith(app, "incident")) {
      if (asked.has(m)) continue;
      asked.add(m);
      void answers.reload(m);
    }
  }
  return { answers, rows, lost, open, onRoster };
}
type State = ReturnType<typeof createState>;

/** Время отказа: сегодня — часы, раньше — с датой. */
function since(t: string): string {
  const at = Date.parse(t);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return at >= today.getTime() ? hhmm(at) : `${day(at)} ${hhmm(at)}`;
}

function Incidents() {
  const app = useApp();
  const st = useModule<State>();
  const [all, setAll] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  useEffect(() => st.answers.mount(), [st]);
  const rows = app.use(() => st.rows()).filter((r) => all || r.state !== "stopped");
  const lost = app.use(() => st.lost());
  const words = app.use(() => Object.entries(st.answers.get()).flatMap(([m, a]) => (wordOf(a) ? [`${m} · incident.pending: ${wordOf(a)}`] : [])));
  return (
    <Page>
      <PageHead title={app.wide ? "Инциденты" : undefined}>
        <Btn data-f="open" pri={!all} aria-pressed={!all} onClick={() => setAll(false)}>
          открытые
        </Btn>
        <Btn data-f="all" pri={all} aria-pressed={all} onClick={() => setAll(true)}>
          все
        </Btn>
      </PageHead>
      {words.map((w) => (
        <Note key={w} tone="bad" role="alert">
          {w}
        </Note>
      ))}
      {lost.length > 0 && (
        <>
          <div className="in-cap">Не доставлены</div>
          <div className="in-list">
            {lost.map((a) => {
              const id = `${a.machine}:${a.id}`;
              return (
                <Fragment key={id}>
                  <DisclosureBtn className="in-row in-lost" data-lost={id} open={why === id} onClick={() => setWhy(why === id ? null : id)}>
                    <Dot kind="bad" className="d" />
                    <span className="g">
                      <span className="t1">
                        <b>{machineLabel(app, a.machine).text}</b>
                        <span className="s bad">{a.refused?.word ?? "ждёт"}</span>
                      </span>
                      <span className="t2">{a.refused ? `с ${since(a.refused.t)}` : [a.type, a.key].filter(Boolean).join(" · ")}</span>
                    </span>
                  </DisclosureBtn>
                  {why === id && (
                    <div className="in-why" data-why={id}>
                      {a.refused?.why ?? "Отказа не записано: причина — в журнале машины."}
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>
        </>
      )}
      {rows.length ? (
        <>
          <div className="in-cap">В сессиях</div>
          <div className="in-list">
          {rows.map((r) => {
            const s = sessionLabel(app, r.callsign);
            return (
              <button key={r.callsign} type="button" className="in-row" data-incident={r.callsign} onClick={() => app.open("card", { callsign: r.callsign })}>
                <Dot kind={r.dot} className="d" />
                <span className="g">
                  <span className="t1">
                    <b>{r.type}</b>
                    {r.key && <span className="k">{r.key}</span>}
                    <span className="s">{r.state === "stopped" ? "закрыт" : stateLabel(r.state).text}</span>
                  </span>
                  <span className="t2">
                    <span className="m">{s.text}</span> · {machineLabel(app, r.callsign.slice(r.callsign.indexOf("@") + 1)).text}
                  </span>
                </span>
              </button>
            );
          })}
          </div>
        </>
      ) : lost.length ? null : (
        <Note>{all ? "Инцидентов нет" : "Открытых инцидентов нет"}</Note>
      )}
    </Page>
  );
}

export function createIncidents(app: App): AppModule {
  const st = createState(app);
  return {
    state: st,
    on: { roster: st.onRoster, link: (s, m) => st.answers.onLink(s, m) },
    screens: {
      incidents: {
        nav: "Инциденты",
        label: "Инциденты",
        narrowGroup: "Флот",
        mark: "incidents.open",
        view: Incidents,
        find: (q) =>
          st
            .rows()
            .filter((r) => [r.type, r.key, r.callsign].some((v) => v?.toLowerCase().includes(q.trim().toLowerCase())))
            .map((r) => ({ label: `${r.type} · ${r.callsign}`, hint: "инцидент", dot: r.dot, screen: "incidents" })),
      },
    },
    marks: { "incidents.open": () => st.open() },
    css,
  };
}
