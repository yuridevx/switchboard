// Экран «Журнал флота»: записи по дням, выбор машины, поиск по загруженному.
import { useState } from "react";
import { Btn, hhmm, In, machineLabel, Note, Pad, PageHead, Sel, useApp } from "@switchboard/web-ui";
import type { LedgerEvent } from "@switchboard/ledger";
import { useLedger } from "./ledger.ts";

const DAY = 86_400_000;
const midnightOf = (t: number) => new Date(t).setHours(0, 0, 0, 0);

function dayName(t: number): string {
  const days = Math.round((midnightOf(Date.now()) - midnightOf(t)) / DAY);
  return days === 0 ? "Сегодня" : days === 1 ? "Вчера" : new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

function Row({ e }: { e: LedgerEvent }) {
  const app = useApp();
  return (
    <div className="jr-r" data-id={e.id}>
      <span>{hhmm(e.t)}</span>
      <span>
        {e.text}
        {e.by ? <span className="by">{` · by ${e.by}`}</span> : null}
      </span>
      <em>{e.callsign ?? (e.machine ? machineLabel(app, e.machine).text : e.from)}</em>
    </div>
  );
}

export function JournalScreen() {
  const app = useApp();
  const [machine, setMachine] = useState("");
  const [query, setQuery] = useState("");
  const { events, more, error, loading, older } = useLedger(machine);
  const online = app.use(() => app.roster()?.machines.map((m) => m.machine).join("\n") ?? "");
  const machines = [...new Set([...online.split("\n").filter(Boolean), ...events.flatMap((e) => (e.machine ? [e.machine] : []))])].sort();
  const needle = query.trim().toLowerCase();
  const shown = events.filter((e) => !needle || [e.text, e.ev, e.machine, e.callsign, e.from, e.by].some((x) => x?.toLowerCase().includes(needle)));
  return (
    <Pad>
      <PageHead title={app.wide ? "Журнал флота" : undefined}>
        <In data-f="q" type="search" value={query} placeholder="⌕ поиск по записям" aria-label="Поиск по записям" onInput={(e) => setQuery(e.currentTarget.value)} />
        <Sel data-f="machine" value={machine} aria-label="Машина" onChange={(e) => setMachine(e.currentTarget.value)}>
          <option value="">все машины</option>
          {machines.map((m) => (
            <option key={m} value={m}>
              {machineLabel(app, m).text}
            </option>
          ))}
        </Sel>
      </PageHead>
      {error ? (
        <Note tone="bad" role="alert">
          {`ledger.read: ${error}`}
        </Note>
      ) : null}
      <div data-ledger="">
        {shown.length
          ? shown.map((e, i) => (
              <div key={e.id} style={{ display: "contents" }}>
                {i === 0 || dayName(shown[i - 1].t) !== dayName(e.t) ? <div className="jr-day">{dayName(e.t)}</div> : null}
                <Row e={e} />
              </div>
            ))
          : loading
            ? "…"
            : "Записей нет."}
      </div>
      {more ? <Btn onClick={() => void older()}>Раньше</Btn> : null}
    </Pad>
  );
}
