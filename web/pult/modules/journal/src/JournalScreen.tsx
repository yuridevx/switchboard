// Экран журнала флота: записи новые сверху, по дням; текст — как прислал ledger.
import { Fragment, useState } from "react";
import { Btn, hhmm, In, machineLabel, machinesWith, Note, Opts, Page, PageHead, Sec, Sel, useApp } from "@switchboard/web-ui";
import { type LedgerEvent, useLedger } from "./ledger.ts";

const DAY_MS = 86_400_000;

function dayName(t: number): string {
  const d = new Date(t);
  const now = Date.now();
  if (d.toDateString() === new Date(now).toDateString()) return "Сегодня";
  if (d.toDateString() === new Date(now - DAY_MS).toDateString()) return "Вчера";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

function Row({ e }: { e: LedgerEvent }) {
  const app = useApp();
  const machine = app.use(() => (e.machine ? machineLabel(app, e.machine).text : ""));
  return (
    <div className="jr-r" data-id={e.id}>
      <span>{hhmm(e.t)}</span>
      <span>
        {e.text}
        {e.by ? <span className="by">{` · by ${e.by}`}</span> : null}
      </span>
      <em>{e.callsign ?? (machine || e.from)}</em>
    </div>
  );
}

/** Поиск — по уже загруженным записям. */
function found(e: LedgerEvent, q: string): boolean {
  return !q || [e.text, e.ev, e.machine, e.callsign, e.by].some((x) => x?.toLowerCase().includes(q));
}

function Ledger({ machine, pick, q, setQ }: { machine: string; pick(m: string): void; q: string; setQ(v: string): void }) {
  const app = useApp();
  const { events, more, reading, refused, older } = useLedger(machine);
  const online = app.use(() => machinesWith(app));
  const machines = [...new Set([...online, ...events.flatMap((e) => (e.machine ? [e.machine] : []))])].sort();
  const names = app.use(() => Object.fromEntries(machines.map((m) => [m, machineLabel(app, m).text])));
  const needle = q.trim().toLowerCase();
  const shown = events.filter((e) => found(e, needle));
  return (
    <Page>
      <PageHead title="Журнал флота">
        <In data-f="q" type="search" placeholder="⌕ поиск по записям" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
        <Sel data-f="machine" value={machine} onChange={(e) => pick(e.currentTarget.value)}>
          <option value="">все машины</option>
          {machines.map((m) => (
            <option key={m} value={m}>
              {names[m] ?? m}
            </option>
          ))}
        </Sel>
      </PageHead>
      {refused ? (
        <Note tone="bad" role="alert">
          {`ledger.read: ${refused}`}
        </Note>
      ) : null}
      <Sec data-ledger="">
        {shown.map((e, i) => {
          const day = dayName(e.t);
          return (
            <Fragment key={e.id}>
              {i === 0 || dayName(shown[i - 1].t) !== day ? <div className="jr-day">{day}</div> : null}
              <Row e={e} />
            </Fragment>
          );
        })}
        {shown.length ? null : <Note>{reading ? "…" : "Записей нет."}</Note>}
      </Sec>
      {more ? (
        <Opts>
          <Btn onClick={() => void older()}>Раньше</Btn>
        </Opts>
      ) : null}
    </Page>
  );
}

export function JournalScreen() {
  const [machine, setMachine] = useState("");
  const [q, setQ] = useState("");
  return <Ledger key={machine} machine={machine} pick={setMachine} q={q} setQ={setQ} />;
}
