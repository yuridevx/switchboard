// pult-journal — журнал флота: записи ledger новые сверху, по дням; текст — как прислал ledger.
// Пока экран открыт, каждый roster — повод дочитать новые записи (after = последний id).
import { useEffect, useRef, useState } from "react";
import type { App, AppModule } from "@switchboard/web-core";
import { Btn, hhmm, In, Note, Opts, Page, PageHead, Sec, Sel } from "@switchboard/web-ui";
import css from "./journal.css";

type Ev = { id: number; t: number; ev: string; from: string; by?: string; machine?: string; callsign?: string; text: string };

function dayOf(t: number): string {
  const d = new Date(t);
  const today = new Date();
  const yest = new Date(today.getTime() - 86_400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  return same(d, today) ? "Сегодня" : same(d, yest) ? "Вчера" : d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createJournal(): AppModule {
  let app: App;

  function Journal() {
    const [evs, setEvs] = useState<Ev[]>([]);
    const [more, setMore] = useState(false);
    const [machine, setMachine] = useState("");
    const [q, setQ] = useState("");
    const [err, setErr] = useState("");
    const reading = useRef(false);
    const [busy, setBusy] = useState(false);
    const known = useRef<Ev[]>([]);
    known.current = evs;

    async function read(body: Record<string, unknown>, how: "all" | "older" | "newer", from = machine) {
      reading.current = true;
      setBusy(true);
      const r = await app.request<{ events: Ev[]; more: boolean }>("ledger.read", { limit: 50, ...(from ? { machine: from } : {}), ...body });
      reading.current = false;
      setBusy(false);
      if (!r.ok) return setErr(`ledger.read: ${r.error}`);
      setErr("");
      if (how === "all") {
        setEvs(r.result.events);
        setMore(r.result.more);
      } else if (how === "older") {
        setEvs((old) => [...old, ...r.result.events]);
        setMore(r.result.more);
      } else {
        setEvs((old) => {
          const ids = new Set(old.map((e) => e.id));
          return [...r.result.events.filter((e) => !ids.has(e.id)), ...old].sort((a, b) => b.id - a.id);
        });
      }
    }

    // первое чтение и новый roster — дочитать записи после последней
    const seen = app.use(() => app.roster());
    const first = useRef(true);
    useEffect(() => {
      if (first.current) {
        first.current = false;
        void read({}, "all");
        return;
      }
      if (reading.current) return;
      if (!known.current.length) return void read({}, "all");
      void read({ after: Math.max(...known.current.map((e) => e.id)) }, "newer");
    }, [seen]);

    const names = [...new Set([...(seen?.machines ?? []).map((m) => m.machine), ...evs.map((e) => e.machine).filter((x): x is string => !!x)])].sort();
    const t = q.trim().toLowerCase();
    const shown = evs.filter((e) => !t || [e.text, e.ev, e.machine, e.callsign, e.by].some((x) => x?.toLowerCase().includes(t)));
    let last = "";
    return (
      <Page>
        <PageHead title="Журнал флота">
          <In data-f="q" type="search" placeholder="⌕ поиск по записям" onInput={(e) => setQ(e.currentTarget.value)} />
          <Sel
            data-f="machine"
            value={machine}
            onChange={(e) => {
              const m = e.currentTarget.value;
              setMachine(m);
              void read({}, "all", m);
            }}
          >
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
          {shown.map((e) => {
            const d = dayOf(e.t);
            const head = d !== last;
            last = d;
            return (
              <div key={e.id} style={{ display: "contents" }}>
                {head ? <div className="jr-day">{d}</div> : null}
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
          })}
          {shown.length ? null : <Note>{busy ? "…" : "Записей нет."}</Note>}
        </Sec>
        {more ? (
          <Opts>
            <Btn onClick={() => void read({ before: Math.min(...evs.map((e) => e.id)) }, "older")}>Раньше</Btn>
          </Opts>
        ) : null}
      </Page>
    );
  }

  return {
    screens: { journal: { nav: "Журнал", group: "Флот", label: "Журнал флота", view: Journal, head: () => ({ title: "Журнал флота" }) } },
    css,
    start(a) {
      app = a;
    },
  };
}
