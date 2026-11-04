// Записи журнала одной выборки: живут только на экране. Первое чтение при открытии; пока экран открыт, смена состава флота или возврат связи дочитывает новое.
import { useEffect, useState } from "react";
import { useApp } from "@switchboard/web-ui";

export type LedgerEvent = { id: number; t: number; ev: string; from: string; by?: string; machine?: string; callsign?: string; text: string };
type Page = { events: LedgerEvent[]; more: boolean };
type View = { events: LedgerEvent[]; more: boolean; reading: boolean; refused: string };

/** Новые записи в начало, без повторов. */
function newer(old: LedgerEvent[], fresh: LedgerEvent[]): LedgerEvent[] {
  const known = new Set(old.map((e) => e.id));
  return [...fresh.filter((e) => !known.has(e.id)), ...old].sort((a, b) => b.id - a.id);
}

/** Выборка машины: другая машина — новый компонент, поэтому ответ прежней до новой не дойдёт. */
export function useLedger(machine: string) {
  const app = useApp();
  const [view, setView] = useState<View>({ events: [], more: false, reading: true, refused: "" });
  const scope = machine ? { limit: 50, machine } : { limit: 50 };
  // журнал пишется при входе и уходе машин и сессий
  const crew = app.use(() => {
    const r = app.roster();
    return [app.link(), (r?.machines ?? []).map((m) => `${m.machine}:${m.since}`), (r?.sessions ?? []).map((s) => s.callsign)].join("|");
  });

  useEffect(() => {
    let gone = false;
    const known = view.events;
    setView((v) => ({ ...v, reading: true }));
    void app.read<Page>("ledger.read", known.length ? { ...scope, after: known[0].id } : scope).then((r) => {
      if (gone) return;
      setView((v) =>
        r.ok
          ? { events: newer(v.events, r.result.events), more: known.length ? v.more : r.result.more, reading: false, refused: "" }
          : { ...v, reading: false, refused: r.error },
      );
    });
    return () => {
      gone = true;
    };
    // читает заново только смена состава: записи читаются из этого же рисования
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crew]);

  async function older(): Promise<void> {
    const r = await app.read<Page>("ledger.read", { ...scope, before: view.events.at(-1)!.id });
    setView((v) => (r.ok ? { ...v, events: [...v.events, ...r.result.events], more: r.result.more, refused: "" } : { ...v, refused: r.error }));
  }

  return { ...view, older };
}
