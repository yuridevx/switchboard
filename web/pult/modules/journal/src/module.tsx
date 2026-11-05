// pult-journal: журнал флота — записи ledger по дням. Записи живут только на экране; дочитывание — при смене состава флота и возврате связи.
import { useEffect, useRef, useState } from "react";
import type { LedgerEvent, LedgerReadResult } from "@switchboard/ledger";
import type { AppModule } from "@switchboard/web-core";
import { Btn, hhmm, In, machineLabel, Note, Page, PageHead, Sel, useApp, type App, type Result } from "@switchboard/web-ui";
import css from "./journal.css";

const LIMIT = 50;
type Shown = { events: LedgerEvent[]; more: boolean; loaded: boolean; error: string };

/** Подпись дня: «Сегодня», «Вчера», «31 октября». */
function dayOf(t: number): string {
  const d = new Date(t).toDateString();
  const now = new Date();
  if (d === now.toDateString()) return "Сегодня";
  if (d === new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toDateString()) return "Вчера";
  return new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

/** Состав флота: машины с их since и сессии; пока связи нет — пусто. */
const fleetOf = (app: App) => {
  const r = app.roster();
  if (app.link() !== "open" || !r) return "";
  return [...r.machines.map((m) => `${m.machine}:${m.since}`), ...r.sessions.map((s) => s.callsign).sort()].join("\n");
};

function Journal() {
  const app = useApp();
  const [machine, setMachine] = useState("");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState<Shown>({ events: [], more: false, loaded: false, error: "" });
  const latest = useRef({ asked: 0, busy: false, shown });
  latest.current.shown = shown;

  /** Вопрос к ledger: ответ устаревшего вопроса отброшен. */
  async function ask(m: string, body: Record<string, unknown>, apply: (r: Result<LedgerReadResult>) => (was: Shown) => Shown) {
    const n = ++latest.current.asked;
    latest.current.busy = true;
    const r = await app.read<LedgerReadResult>("ledger.read", { limit: LIMIT, ...(m ? { machine: m } : {}), ...body });
    if (n !== latest.current.asked) return;
    latest.current.busy = false;
    setShown(apply(r));
  }
  const failed = (r: Result<unknown>) => (was: Shown) => ({ ...was, loaded: true, error: r.ok ? "" : `ledger.read: ${r.error}` });
  const all = (m: string) => ask(m, {}, (r) => (r.ok ? () => ({ ...r.result, loaded: true, error: "" }) : failed(r)));

  /** Новые записи сверху; «Раньше» — как было. Записей нет — читается всё. */
  function catchUp() {
    const { busy, shown: now } = latest.current;
    if (busy) return;
    if (!now.events.length) return void all(machine);
    const known = new Set(now.events.map((e) => e.id));
    void ask(machine, { after: now.events[0].id }, (r) => (r.ok ? (was) => ({ ...was, events: [...r.result.events.filter((e) => !known.has(e.id)), ...was.events], error: "" }) : failed(r)));
  }
  const earlier = () =>
    void ask(machine, { before: shown.events.at(-1)!.id }, (r) => (r.ok ? (was) => ({ ...was, events: [...was.events, ...r.result.events], more: r.result.more, error: "" }) : failed(r)));

  const fleet = app.use(() => fleetOf(app));
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (seen.current === null) void all(machine);
    else if (fleet && fleet !== seen.current) catchUp();
    seen.current = fleet;
  }, [fleet]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (m: string) => {
    setMachine(m);
    void all(m);
  };

  const online = app.use(() => (app.roster()?.machines ?? []).map((m) => m.machine));
  const machines = [...new Set([...online, ...shown.events.flatMap((e) => (e.machine ? [e.machine] : []))])].sort();
  const words = q.trim().toLowerCase();
  const rows = words ? shown.events.filter((e) => [e.text, e.ev, e.machine, e.callsign, e.by, e.from].some((v) => v?.toLowerCase().includes(words))) : shown.events;

  return (
    <Page>
      <PageHead title="Журнал флота">
        <In data-f="q" type="search" placeholder="⌕ поиск по записям" onInput={(e) => setQ(e.currentTarget.value)} />
        <Sel data-f="machine" value={machine} onChange={(e) => pick(e.currentTarget.value)}>
          <option value="">все машины</option>
          {machines.map((m) => (
            <option key={m} value={m}>
              {machineLabel(app, m).text}
            </option>
          ))}
        </Sel>
      </PageHead>
      {shown.error && (
        <Note tone="bad" role="alert">
          {shown.error}
        </Note>
      )}
      <div data-ledger="">
        {!shown.loaded ? "…" : !rows.length ? "Записей нет." : rows.map((e, i) => <Row key={e.id} e={e} day={i === 0 || dayOf(rows[i - 1].t) !== dayOf(e.t) ? dayOf(e.t) : null} app={app} />)}
      </div>
      {shown.more && <Btn onClick={earlier}>Раньше</Btn>}
    </Page>
  );
}

function Row({ e, day, app }: { e: LedgerEvent; day: string | null; app: App }) {
  return (
    <>
      {day && <div className="jr-day">{day}</div>}
      <div className="jr-r" data-id={e.id}>
        <span>{hhmm(e.t)}</span>
        <span>
          {e.text}
          {e.by && <span className="by"> · by {e.by}</span>}
        </span>
        <em>{e.callsign ?? (e.machine ? machineLabel(app, e.machine).text : e.from)}</em>
      </div>
    </>
  );
}

export function createJournal(_app: App): AppModule {
  return { screens: { journal: { nav: "Журнал", group: "Флот", view: Journal } }, css };
}
