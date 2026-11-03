// Вкладка «Журнал» широкой карточки: записи машины об этой сессии; фильтр по виду, «дальше» и «раньше».
import { useState } from "react";
import { useApp } from "@switchboard/web-core";
import { hhmm, midnight, useLoad } from "@switchboard/web-ui";

type Rec = { t: string; part?: string; who?: string; kind?: string; ev?: string; word?: string; why?: string };

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
    () => app.request<{ records: Rec[]; more: boolean }>("machine.journal", { machine, session: callsign, since: paged.from ?? midnight(days), limit: 50, ...(kind ? { kind: [kind] } : {}) }),
    [machine, callsign, kind, days, paged.from],
  );
  // пока читается «дальше», прошлая страница уже в paged.recs; смена выборки оставляет прошлое до ответа
  const recs = [...paged.recs, ...(q.data && !(q.loading && paged.from) ? q.data.records : [])];
  const reset = () => setPaged({ recs: [], from: null });

  return (
    <div className="cw-log">
      <div className="cw-opts flat">
        {KINDS.map((k) => (
          <button
            key={k}
            className="cw-b"
            aria-pressed={kind === k ? "true" : "false"}
            onClick={() => {
              setKind(k);
              reset();
            }}
          >
            {k || "все"}
          </button>
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
        <button className="cw-b" onClick={() => setPaged({ recs, from: recs.at(-1)!.t })}>
          дальше →
        </button>
      ) : null}
      <button
        className="cw-b"
        onClick={() => {
          setDays(days + 1);
          reset();
        }}
      >
        Раньше
      </button>
    </div>
  );
}
