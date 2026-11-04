// Экран журнала флота: записи новые сверху, по дням; текст — как прислал ledger. Записи живут только на экране.
// Первое чтение при открытии и выборе машины; пока экран открыт, смена состава флота дочитывает новые записи.
import { useState } from "react";
import { Btn, hhmm, In, Note, Opts, Page, PageHead, Sec, Sel, useApp, useLoad, machinesWith } from "@switchboard/web-ui";

export type Ev = { id: number; t: number; ev: string; from: string; by?: string; machine?: string; callsign?: string; text: string };
type Answer = { events: Ev[]; more: boolean };

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

/** Записи одной выборки: другая машина — новый компонент, ответы прежней до него не дойдут. */
function useLedger(machine: string) {
  const app = useApp();
  const [evs, setEvs] = useState<Ev[]>([]);
  const [more, setMore] = useState(false);
  const [olderRefused, setOlderRefused] = useState("");
  const [merged, setMerged] = useState<Answer | undefined>();
  const body = machine ? { limit: 50, machine } : { limit: 50 };
  // журнал пишется при входе и уходе машин и сессий: смена состава или возврат связи — дочитать
  const crew = app.use(() => {
    const r = app.roster();
    return `${app.link()}|${(r?.machines ?? []).map((m) => `${m.machine}:${m.since}`).join()}|${(r?.sessions ?? []).map((s) => s.callsign).join()}`;
  });
  const q = useLoad<Answer>(() => app.read<Answer>("ledger.read", evs.length ? { ...body, after: Math.max(...evs.map((e) => e.id)) } : body), [machine], crew);
  // ответ вливается в записи при рисовании: новые сверху, без повторов
  if (q.data && q.data !== merged) {
    const fresh = q.data;
    setMerged(fresh);
    setOlderRefused("");
    if (!evs.length) setMore(fresh.more);
    const ids = new Set(evs.map((e) => e.id));
    setEvs([...fresh.events.filter((e) => !ids.has(e.id)), ...evs].sort((a, b) => b.id - a.id));
  }
  async function older() {
    const r = await app.read<Answer>("ledger.read", { ...body, before: Math.min(...evs.map((e) => e.id)) });
    if (!r.ok) return setOlderRefused(r.error);
    setOlderRefused("");
    setEvs((old) => [...old, ...r.result.events]);
    setMore(r.result.more);
  }
  return { evs, more, older, busy: q.loading, refused: olderRefused || q.error };
}

function Ledger({ machine, pick, q, setQ }: { machine: string; pick(m: string): void; q: string; setQ(v: string): void }) {
  const app = useApp();
  const { evs, more, older, busy, refused } = useLedger(machine);
  const online = app.use(() => machinesWith(app));
  const names = [...new Set([...online, ...evs.map((e) => e.machine).filter((x): x is string => !!x)])].sort();
  const t = q.trim().toLowerCase();
  const shown = evs.filter((e) => !t || [e.text, e.ev, e.machine, e.callsign, e.by].some((x) => x?.toLowerCase().includes(t)));
  return (
    <Page>
      <PageHead title="Журнал флота">
        <In data-f="q" type="search" placeholder="⌕ поиск по записям" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
        <Sel data-f="machine" value={machine} onChange={(e) => pick(e.currentTarget.value)}>
          <option value="">все машины</option>
          {names.map((m) => (
            <option key={m} value={m}>
              {m}
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
          const d = dayOf(e.t);
          return <EvRow key={e.id} e={e} day={i === 0 || dayOf(shown[i - 1].t) !== d ? d : null} />;
        })}
        {shown.length ? null : <Note>{busy ? "…" : "Записей нет."}</Note>}
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
