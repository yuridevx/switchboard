// Записи журнала на экране: живут, пока экран открыт. Одно чтение за раз: заново, дочитать новые или раньше; новый запрос отменяет опоздавший ответ.
import { useEffect, useRef, useState } from "react";
import { useApp } from "@switchboard/web-ui";
import type { LedgerEvent, LedgerReadResult } from "@switchboard/ledger";

type Page = { events: LedgerEvent[]; more: boolean; error: string; loading: boolean };
const START: Page = { events: [], more: false, error: "", loading: true };
const LIMIT = 50;
const newestFirst = (a: LedgerEvent, b: LedgerEvent) => b.id - a.id;

/** Состав флота: сменился — журнал мог получить записи; roster без смены состава журнал не читает. */
function fleetOf(app: ReturnType<typeof useApp>): string {
  const r = app.roster();
  return JSON.stringify([app.link() === "open", r?.machines.map((m) => [m.machine, m.since]), r?.sessions.map((s) => s.callsign)]);
}

export function useLedger(machine: string) {
  const app = useApp();
  const fleet = app.use(() => fleetOf(app));
  const [page, setPage] = useState(START);
  const now = useRef(page);
  now.current = page;
  const reading = useRef({ turn: 0, busy: false, machine: null as string | null });

  async function read(body: Record<string, unknown>, merge: (p: Page, r: LedgerReadResult) => Partial<Page>): Promise<void> {
    const turn = ++reading.current.turn;
    reading.current.busy = true;
    const r = await app.read<LedgerReadResult>("ledger.read", { limit: LIMIT, ...(machine ? { machine } : {}), ...body });
    if (turn !== reading.current.turn) return;
    reading.current.busy = false;
    setPage((p) => ({ ...p, loading: false, ...(r.ok ? { error: "", ...merge(p, r.result) } : { error: r.error }) }));
  }

  useEffect(() => {
    const again = reading.current.machine !== machine;
    if (!again && reading.current.busy) return;
    reading.current.machine = machine;
    if (again) setPage(START);
    const newest = again ? undefined : now.current.events[0]?.id;
    if (newest === undefined) void read({}, (_p, r) => ({ events: r.events.toSorted(newestFirst), more: r.more }));
    else void read({ after: newest }, (p, r) => ({ events: [...r.events.filter((e) => e.id > newest).toSorted(newestFirst), ...p.events] }));
    // читать заново говорят машина и состав флота; read меняется с каждым рисованием
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine, fleet]);

  const older = () => read({ before: page.events.at(-1)?.id }, (p, r) => ({ events: [...p.events, ...r.events], more: r.more }));
  return { ...page, older };
}
