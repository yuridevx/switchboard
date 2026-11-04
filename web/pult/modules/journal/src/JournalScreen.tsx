// Экран журнала флота: записи новые сверху, по дням; текст — как прислал ledger.
import { useEffect, useState } from "react";
import { Btn, hhmm, In, Note, Opts, Page, PageHead, Sec, Sel, useApp, machinesWith } from "@switchboard/web-ui";
import { useJournal } from "./store.ts";
import type { Ev } from "./store.ts";

function dayOf(t: number): string {
  const d = new Date(t);
  const today = new Date();
  const yest = new Date(today.getTime() - 86_400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  return same(d, today) ? "Сегодня" : same(d, yest) ? "Вчера" : d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

function EvRow({ e, day }: { e: Ev; day: string | null }) {
  return (
    <div style={{ display: "contents" }}>
      {day ? <div className="jr-day">{day}</div> : null}
      <div className="jr-r" data-id={e.id}>
        <span>{hhmm(e.t)}</span>
        <span>
          {e.text}
          {e.by ? <span className="by">{` · by ${e.by}`}</span> : null}
        </span>
        <em>{e.callsign ?? e.machine ?? e.from}</em>
      </div>
    </div>
  );
}

export function JournalScreen() {
  const app = useApp();
  const journal = useJournal();
  const { evs, more, machine, err, busy } = app.use(journal.view);
  useEffect(() => journal.mount(), [journal]);
  const [q, setQ] = useState("");
  const online = app.use(() => machinesWith(app));
  const names = [...new Set([...online, ...evs.map((e) => e.machine).filter((x): x is string => !!x)])].sort();
  const t = q.trim().toLowerCase();
  const shown = evs.filter((e) => !t || [e.text, e.ev, e.machine, e.callsign, e.by].some((x) => x?.toLowerCase().includes(t)));
  return (
    <Page>
      <PageHead title="Журнал флота">
        <In data-f="q" type="search" placeholder="⌕ поиск по записям" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
        <Sel data-f="machine" value={machine} onChange={(e) => journal.pickMachine(e.currentTarget.value)}>
          <option value="">все машины</option>
          {names.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Sel>
      </PageHead>
      {err ? (
        <Note tone="bad" role="alert">
          {err}
        </Note>
      ) : null}
      <Sec data-ledger="">
        {shown.map((e, i) => {
          const d = dayOf(e.t);
          return <EvRow key={e.id} e={e} day={i === 0 || dayOf(shown[i - 1].t) !== d ? d : null} />;
        })}
        {shown.length ? null : <Note>{busy ? "…" : "Записей нет."}</Note>}
      </Sec>
      {more ? (
        <Opts>
          <Btn onClick={journal.older}>Раньше</Btn>
        </Opts>
      ) : null}
    </Page>
  );
}
