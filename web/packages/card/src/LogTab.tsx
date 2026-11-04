// Вкладка «Журнал» широкой карточки: записи машины об этой сессии; фильтр по виду, «дальше» и «раньше».
import type { JournalAnswer, JournalRecord } from "@switchboard/web-ui";
import { useState } from "react";
import { hhmm, midnight, useLoad, useApp, Btn } from "@switchboard/web-ui";

type Rec = JournalRecord;

const KINDS = ["", "stop", "refuse", "note"];

function timeOf(t: string): string {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? t : `${hhmm(d)}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function LogTab({ machine, callsign }: { machine: string; callsign: string }) {
  const app = useApp();
  const [kind, setKind] = useState("");
  const [days, setDays] = useState(0);
  /** страницы до текущей и откуда читать текущую: «дальше» их наращивает, смена выборки сбрасывает */
  const [paged, setPaged] = useState<{ recs: Rec[]; from: string | null }>({ recs: [], from: null });
  const q = useLoad(
    () => app.read<JournalAnswer>("machine.journal", { machine, session: callsign, since: paged.from ?? midnight(days), limit: 50, ...(kind ? { kind: [kind] } : {}) }),
    [machine, callsign, kind, days, paged.from],
  );
  // пока читается «дальше», прошлая страница уже в paged.recs; смена выборки оставляет прошлое до ответа
  const recs = [...paged.recs, ...(q.data && !(q.loading && paged.from) ? q.data.records : [])];
  const reset = () => setPaged({ recs: [], from: null });

  return (
    <div className="cw-log">
      <div className="cw-opts flat">
        {KINDS.map((k) => (
          <Btn
            key={k}
           
            aria-pressed={kind === k ? "true" : "false"}
            onClick={() => {
              setKind(k);
              reset();
            }}
          >
            {k || "все"}
          </Btn>
        ))}
        <span className="cw-note">{`${machine} · ${days ? `с ${days} дн. назад` : "сегодня"}`}</span>
      </div>
      {q.error ? (
        <div className="cw-note bad" role="alert">
          {`machine.journal: ${q.error}`}
        </div>
      ) : null}
      {recs.map((x, i) => (
        <div key={`${x.t}:${i}`} className="cw-lr">
          <span>{timeOf(x.t)}</span>
          <span className={`k ${x.kind ?? ""}`}>{x.kind ?? ""}</span>
          <span className="w">{[x.part, x.who].filter(Boolean).join(" · ")}</span>
          <span className="x">{[x.ev, x.word, x.why].filter(Boolean).join(" · ")}</span>
        </div>
      ))}
      {!recs.length && !q.loading && !q.error ? <div className="cw-note">Записей нет.</div> : null}
      {q.data?.more && !q.loading ? (
        <Btn onClick={() => setPaged({ recs, from: recs.at(-1)!.t })}>
          дальше →
        </Btn>
      ) : null}
      <Btn
        onClick={() => {
          setDays(days + 1);
          reset();
        }}
      >
        Раньше
      </Btn>
    </div>
  );
}
