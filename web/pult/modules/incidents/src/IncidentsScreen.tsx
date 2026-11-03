// Экран инцидентов: не доставленные обращения и сессии с инцидентом. Строка читает только своё и перерисовывается одна.
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { Btn, Dot, hhmm, machineLabel, Note, Page, PageHead, sessionLabel, stateLabel } from "@switchboard/web-ui";
import { useIncidents } from "./context.ts";
import { incOf, isOpen, type Lost } from "./store.ts";

const LostRow = memo(function LostRow({ x, picked, pick }: { x: Lost; picked: boolean; pick(k: string): void }) {
  const app = useApp();
  const k = `${x.machine}:${x.id}`;
  const name = app.use(() => machineLabel(app, x.machine).text);
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

const SessionRow = memo(function SessionRow({ callsign }: { callsign: string }) {
  const app = useApp();
  const incidents = useIncidents();
  const s = app.use(() => incidents.sessions().find((x) => x.callsign === callsign));
  const name = app.use(() => sessionLabel(app, callsign).text);
  const machine = machineOf(callsign) ?? "";
  const host = app.use(() => machineLabel(app, machine).text);
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

export function IncidentsScreen() {
  const app = useApp();
  const incidents = useIncidents();
  const [all, setAll] = useState(false);
  const [picked, setPicked] = useState("");
  const list = app.use(() => incidents.sessions().filter((s) => all || isOpen(s)).map((s) => s.callsign));
  const lost = app.use(incidents.allLost);
  const refused = app.use(incidents.refused);
  const words = useMemo(() => Object.entries(refused), [refused]);
  useEffect(() => void incidents.load(), [incidents]);
  const pick = useCallback((k: string) => setPicked((old) => (old === k ? "" : k)), []);
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
      {lost.length ? (
        <>
          <div className="in-cap">
            <Dot kind="bad" />
            Не доставлены
          </div>
          <div className="in-list">
            {lost.map((x) => {
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
