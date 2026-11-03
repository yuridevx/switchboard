// Записи журнала на экране: первое чтение при открытии; пока экран открыт, каждый roster — дочитать новые (after = последний id).
import { useEffect, useState } from "react";
import { useApp } from "@switchboard/web-core";
import { useJournal } from "./context.ts";

export type Ev = { id: number; t: number; ev: string; from: string; by?: string; machine?: string; callsign?: string; text: string };

export function useLedger() {
  const app = useApp();
  const journal = useJournal();
  const [evs, setEvs] = useState<Ev[]>([]);
  const [more, setMore] = useState(false);
  const [machine, setMachine] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function read(body: Record<string, unknown>, how: "all" | "older" | "newer", from = machine) {
    setBusy(true);
    const r = await app.request<{ events: Ev[]; more: boolean }>("ledger.read", { limit: 50, ...(from ? { machine: from } : {}), ...body });
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

  // открытие и каждый roster: идёт чтение — пропустить; записей нет — прочитать все, иначе после последней
  const arrived = app.use(journal.rosters);
  useEffect(() => {
    if (busy) return;
    if (!evs.length) return void read({}, "all");
    void read({ after: Math.max(...evs.map((e) => e.id)) }, "newer");
    // следит только за приходом roster: записи и занятость — его снимок на этот момент
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrived]);

  return {
    evs,
    more,
    machine,
    err,
    busy,
    pickMachine(m: string) {
      setMachine(m);
      void read({}, "all", m);
    },
    older: () => void read({ before: Math.min(...evs.map((e) => e.id)) }, "older"),
  };
}
