// Экран «Инциденты»: недоставленные обращения и сессии инцидентов.
import { useEffect, useState } from "react";
import { Btn, day, DisclosureBtn, Dot, hhmm, incidentOf, lamp, machineLabel, midnight, Note, Page, PageHead, sessionLabel, stateLabel, useApp, useModule, wordOf } from "@switchboard/web-ui";
import { machineOf } from "@switchboard/protocol";
import type { SessionRecord } from "@switchboard/web-core";
import type { IncidentsStore, Lost } from "./store.ts";

/** Время отказа; отказ прошлых дней — с датой. */
function since(iso: string): string {
  const t = Date.parse(iso);
  return t < Date.parse(midnight()) ? `${day(t)} ${hhmm(t)}` : hhmm(t);
}

function LostRow({ row, open, toggle }: { row: Lost; open: boolean; toggle(): void }) {
  const app = useApp();
  const { machine, appeal } = row;
  const mark = `${machine}:${appeal.id}`;
  const { refused } = appeal;
  const what = [appeal.type, appeal.key].filter(Boolean).join(" · ");
  return (
    <>
      <DisclosureBtn className="in-row in-lost" data-lost={mark} open={open} onClick={toggle}>
        <Dot kind="bad" className="d" />
        <span className="g">
          <span className="t1">
            <b>{machineLabel(app, machine).text}</b>
            <span className="s bad">{refused?.word ?? "ждёт"}</span>
          </span>
          <span className="t2">{refused ? `с ${since(refused.t)}` : what}</span>
        </span>
      </DisclosureBtn>
      {open ? (
        <div className="in-why" data-why={mark}>
          {refused?.why ?? "Отказа не записано: причина — в журнале машины."}
        </div>
      ) : null}
    </>
  );
}

function SessionRow({ s }: { s: SessionRecord }) {
  const app = useApp();
  const incident = incidentOf(s)!;
  return (
    <button type="button" className="in-row" data-incident={s.callsign} onClick={() => app.open("card", { callsign: s.callsign })}>
      <Dot kind={lamp(s)} className="d" />
      <span className="g">
        <span className="t1">
          <b>{incident.type}</b>
          {incident.key ? <span className="k">{incident.key}</span> : null}
          <span className="s">{s.state === "stopped" ? "закрыт" : stateLabel(s.state).text}</span>
        </span>
        <span className="t2">
          <span className="m">{sessionLabel(app, s.callsign).text}</span>
          {` · ${machineLabel(app, machineOf(s.callsign) ?? "").text}`}
        </span>
      </span>
    </button>
  );
}

export function IncidentsScreen() {
  const app = useApp();
  const store = useModule<IncidentsStore>();
  const [all, setAll] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  useEffect(() => store.answers.mount(), [store]);
  app.use(() => store.answers.get());
  app.use(() => app.roster());
  const lost = store.lost();
  const sessions = store.sessions().filter((s) => all || s.state !== "stopped");
  const refusals = Object.entries(store.answers.get()).flatMap(([machine, a]) => (wordOf(a) ? [`${machine} · incident.pending: ${wordOf(a)}`] : []));
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
      {refusals.map((text) => (
        <Note key={text} tone="bad" role="alert">
          {text}
        </Note>
      ))}
      {lost.length ? (
        <>
          <div className="in-cap">Не доставлены</div>
          <div className="in-list">
            {lost.map((row) => {
              const mark = `${row.machine}:${row.appeal.id}`;
              return <LostRow key={mark} row={row} open={why === mark} toggle={() => setWhy(why === mark ? null : mark)} />;
            })}
          </div>
        </>
      ) : null}
      {sessions.length ? (
        <>
          <div className="in-cap">В сессиях</div>
          <div className="in-list">
            {sessions.map((s) => (
              <SessionRow key={s.callsign} s={s} />
            ))}
          </div>
        </>
      ) : lost.length ? null : (
        <Note>{all ? "Инцидентов нет" : "Открытых инцидентов нет"}</Note>
      )}
    </Page>
  );
}
