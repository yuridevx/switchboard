// Вкладка «Журнал» широкой карточки: записи машины об этой сессии; фильтр по виду, «дальше» и «раньше».
import { useEffect, useRef, useState } from "react";
import { useApp } from "@switchboard/web-core";
import { hhmm, midnight } from "@switchboard/web-ui";

type Rec = { t: string; part?: string; who?: string; kind?: string; ev?: string; word?: string; why?: string };
type Page = { recs: Rec[]; more: boolean; err: string; loading: boolean };

const KINDS = ["", "stop", "refuse", "note"];

function timeOf(t: string): string {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? t : `${hhmm(d)}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function LogTab({ machine, callsign }: { machine: string; callsign: string }) {
  const app = useApp();
  const [kind, setKind] = useState("");
  const [days, setDays] = useState(0);
  const [page, setPage] = useState<Page>({ recs: [], more: false, err: "", loading: true });
  // новый запрос отменяет прошлый: устаревший ответ не перекрывает выбранное
  const turn = useRef(0);

  async function load(since: string, append: boolean, k: string) {
    const mine = ++turn.current;
    setPage((p) => ({ ...p, loading: true }));
    const r = await app.request<{ records: Rec[]; more: boolean }>("machine.journal", { machine, session: callsign, since, limit: 50, ...(k ? { kind: [k] } : {}) });
    if (mine !== turn.current) return;
    setPage((p) => (r.ok ? { recs: append ? [...p.recs, ...r.result.records] : r.result.records, more: !!r.result.more, err: "", loading: false } : { ...p, err: r.error, loading: false }));
  }

  // при открытии вкладки; дальше читают нажатия
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load(midnight(0), false, ""), []);

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
              void load(midnight(days), false, k);
            }}
          >
            {k || "все"}
          </button>
        ))}
        <span className="cw-note">{`${machine} · ${days ? `с ${days} дн. назад` : "сегодня"}`}</span>
      </div>
      {page.err ? (
        <div className="cw-note bad" role="alert">
          {`machine.journal: ${page.err}`}
        </div>
      ) : null}
      {page.recs.map((x, i) => (
        <div key={`${x.t}:${i}`} className="cw-lr">
          <span>{timeOf(x.t)}</span>
          <span className={`k ${x.kind ?? ""}`}>{x.kind ?? ""}</span>
          <span className="w">{[x.part, x.who].filter(Boolean).join(" · ")}</span>
          <span className="x">{[x.ev, x.word, x.why].filter(Boolean).join(" · ")}</span>
        </div>
      ))}
      {!page.recs.length && !page.loading && !page.err ? <div className="cw-note">Записей нет.</div> : null}
      {page.more ? (
        <button className="cw-b" onClick={() => void load(page.recs.at(-1)!.t, true, kind)}>
          дальше →
        </button>
      ) : null}
      <button
        className="cw-b"
        onClick={() => {
          setDays(days + 1);
          void load(midnight(days + 1), false, kind);
        }}
      >
        Раньше
      </button>
    </div>
  );
}
