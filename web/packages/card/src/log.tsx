// Вкладка «Журнал»: записи машины об этой сессии с полуночи, фильтр вида, «дальше» и «Раньше».
import { useState } from "react";
import { machineOf } from "@switchboard/protocol";
import { Btn, midnight, useApp, useLoad, type JournalAnswer, type JournalRecord } from "@switchboard/web-ui";

const KINDS = ["все", "stop", "refuse", "note"];
const LIMIT = 50;

/** ЧЧ:ММ:СС записи; не дата — как пришло. */
function clock(t: string) {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? t : d.toLocaleTimeString("ru-RU", { hour12: false });
}

export function Log({ callsign }: { callsign: string }) {
  const app = useApp();
  const machine = machineOf(callsign) ?? "";
  const [kind, setKind] = useState("все");
  const [daysBack, setDaysBack] = useState(0);
  const [more, setMore] = useState<{ records: JournalRecord[]; more: boolean } | null>(null);
  const body = { machine, session: callsign, limit: LIMIT, since: midnight(daysBack), ...(kind === "все" ? {} : { kind: [kind] }) };
  const first = useLoad(() => app.read<JournalAnswer>("machine.journal", body), [kind, daysBack]);
  const records = [...(first.data?.records ?? []), ...(more?.records ?? [])];
  const hasMore = more ? more.more : first.data?.more;

  async function next() {
    const r = await app.read<JournalAnswer>("machine.journal", { ...body, since: records.at(-1)!.t });
    if (r.ok) setMore({ records: [...(more?.records ?? []), ...r.result.records], more: r.result.more });
  }
  const refilter = (change: () => void) => {
    setMore(null);
    change();
  };

  return (
    <div className="cw-log">
      <div className="cw-opts flat">
        {KINDS.map((k) => (
          <Btn key={k} aria-pressed={k === kind ? "true" : "false"} onClick={() => refilter(() => setKind(k))}>
            {k}
          </Btn>
        ))}
        <span className="cw-note">{`${machine} · ${daysBack ? `с ${daysBack} дн. назад` : "сегодня"}`}</span>
      </div>
      {first.error ? (
        <div className="cw-note bad" role="alert">{`machine.journal: ${first.error}`}</div>
      ) : !first.loading && !records.length ? (
        <div className="cw-note">Записей нет.</div>
      ) : null}
      {records.map((r, i) => (
        <div key={`${r.t}:${i}`} className="cw-lr">
          <span>{clock(r.t)}</span>
          <span className={`k ${r.kind ?? ""}`}>{r.kind}</span>
          <span className="w">{[r.part, r.who].filter(Boolean).join(" · ")}</span>
          <span className="x">{[r.ev, r.word, r.why].filter(Boolean).join(" · ")}</span>
        </div>
      ))}
      {hasMore && records.length ? <Btn onClick={() => void next()}>дальше →</Btn> : null}
      <Btn onClick={() => refilter(() => setDaysBack(daysBack + 1))}>Раньше</Btn>
    </div>
  );
}
