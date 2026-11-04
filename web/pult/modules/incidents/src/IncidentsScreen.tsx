// Экран инцидентов: недоставленные обращения и сессии с инцидентом. Строка читает только своё и перерисовывается одна.
import { memo, useCallback, useEffect, useState } from "react";
import { machineOf } from "@switchboard/protocol";
import { Btn, DisclosureBtn, Dot, hhmm, machineLabel, Note, Page, PageHead, RowBtn, sessionLabel, stateLabel, useApp } from "@switchboard/web-ui";
import { incident, isOpen, type Lost, useIncidents } from "./store.ts";

const lostKey = (x: Lost) => `${x.machine}:${x.id}`;

const LostRow = memo(function LostRow({ x, open, toggle }: { x: Lost; open: boolean; toggle(k: string): void }) {
  const app = useApp();
  const k = lostKey(x);
  const machine = app.use(() => machineLabel(app, x.machine).text);
  return (
    <>
      <DisclosureBtn className="in-row in-lost" data-lost={k} open={open} onClick={() => toggle(k)}>
        <Dot kind="bad" className="d" />
        <span className="g">
          <span className="t1">
            <b>{machine}</b>
            <span className="s bad">{x.word}</span>
          </span>
          <span className="t2">{x.t ? `с ${hhmm(new Date(x.t))}` : x.what}</span>
        </span>
      </DisclosureBtn>
      {open ? (
        <div className="in-why" data-why={k}>
          {x.why || x.word}
        </div>
      ) : null}
    </>
  );
});

const SessionRow = memo(function SessionRow({ callsign }: { callsign: string }) {
  const app = useApp();
  const store = useIncidents();
  const s = app.use(() => store.sessions().find((x) => x.callsign === callsign));
  const name = app.use(() => sessionLabel(app, callsign).text);
  const machine = app.use(() => machineLabel(app, machineOf(callsign) ?? "").text);
  if (!s) return null;
  const { type, key } = incident(s)!;
  const state = s.state === "stopped" ? { text: "закрыт", dot: "stop" } : stateLabel(s.state);
  return (
    <RowBtn className="in-row" data-incident={callsign} onClick={() => app.open("card", { callsign })}>
      <Dot kind={state.dot} className="d" />
      <span className="g">
        <span className="t1">
          <b>{type}</b>
          {key !== undefined ? <span className="k">{String(key)}</span> : null}
          <span className="s">{state.text}</span>
        </span>
        <span className="t2">
          <span className="m">{name}</span>
          {` · ${machine}`}
        </span>
      </span>
    </RowBtn>
  );
});

export function IncidentsScreen() {
  const app = useApp();
  const store = useIncidents();
  const [all, setAll] = useState(false);
  const [openLost, setOpenLost] = useState("");
  const callsigns = app.use(() => store.sessions().filter((s) => all || isOpen(s)).map((s) => s.callsign));
  const lost = app.use(store.allLost);
  const refused = app.use(store.refused);
  useEffect(() => void store.load(), [store]);
  const toggle = useCallback((k: string) => setOpenLost((old) => (old === k ? "" : k)), []);
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
            {lost.map((x) => (
              <LostRow key={lostKey(x)} x={x} open={openLost === lostKey(x)} toggle={toggle} />
            ))}
          </div>
        </>
      ) : null}
      {Object.entries(refused).map(([m, word]) => (
        <Note key={m} tone="bad" role="alert">{`${m} · machine.journal: ${word}`}</Note>
      ))}
      <div className="in-cap">В сессиях</div>
      {callsigns.length ? (
        <div className="in-list">
          {callsigns.map((c) => (
            <SessionRow key={c} callsign={c} />
          ))}
        </div>
      ) : (
        <Note>{all ? "Инцидентов нет" : "Открытых инцидентов нет"}</Note>
      )}
    </Page>
  );
}
