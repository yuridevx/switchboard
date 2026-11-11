// Список «Сессий»: архив флота (points.list) с переключателями периода и порядка, проект — по доске на странице; поиск по переписке
// (points.list с q) — поле над списком, если хранилище его умеет; «пожар» — машины, которых нет на связи, сверху.
import { useEffect, useState, type ReactNode } from "react";
import { Btn, Chip, Chips, day, Dot, hhmm, In, M, Note, Opts, Page, PageHead, Sec, useApp, useLoad, useModule } from "@switchboard/web-ui";
import { modelName, seen, titleOf, tokens, type Archive, type Fleet, type Hit, type Listed } from "./store.ts";
import { Fire } from "./windows.tsx";
import { refused } from "./words.ts";

const PERIODS: Array<[string, string]> = [["day", "сегодня"], ["week", "неделя"], ["all", "всё время"]];
const ORDERS: Array<[string, string]> = [["last", "последние"], ["tokens", "токены"]];

/** Начало периода: сегодня — с полуночи, неделя — 7 суток назад. */
function sinceOf(period: string): string | undefined {
  if (period === "all") return undefined;
  const d = new Date();
  if (period === "day") d.setHours(0, 0, 0, 0);
  else d.setDate(d.getDate() - 7);
  return d.toISOString();
}

/** Найденное — отмеченным. */
function mark(text: string, q: string): ReactNode {
  const low = text.toLowerCase();
  const ql = q.toLowerCase();
  const out: ReactNode[] = [];
  let at = 0;
  for (let i = low.indexOf(ql); ql && i >= 0; i = low.indexOf(ql, i + ql.length)) {
    out.push(text.slice(at, i), <mark key={i}>{text.slice(i, i + q.length)}</mark>);
    at = i + q.length;
  }
  out.push(text.slice(at));
  return out;
}

/** Сегодня — время, раньше — день. */
const when = (t: number) => (new Date(t).toDateString() === new Date().toDateString() ? hhmm(t) : day(t));

function Picks({ data, value, set, label, f }: { data: Array<[string, string]>; value: string; set(v: string): void; label: string; f: string }) {
  return (
    <Chips data-f={f} aria-label={label}>
      {data.map(([k, n]) => (
        <Chip key={k} on={value === k} onClick={() => set(k)}>
          {n}
        </Chip>
      ))}
    </Chips>
  );
}

function SessionRow({ s }: { s: Listed }) {
  const app = useApp();
  return (
    <button type="button" className="ss-row" data-sid={s.sid} onClick={() => app.open("points", { sid: s.sid })}>
      <Dot kind={s.live ? "idle" : "stop"} title={s.live ? "идёт на машине" : "только в архиве"} />
      <span className="ss-name">
        <span className="ss-title">{titleOf(s)}</span>
        <M>{s.callsign ?? s.sid}</M>
      </span>
      <span className="ss-proj">{s.project ?? ""}</span>
      <span className="ss-model">{modelName(s.model)}</span>
      <span className="ss-num">{tokens(s)}</span>
      <span className="ss-when">{when(s.head.at)}</span>
    </button>
  );
}

function Hits({ q, project, since }: { q: string; project: string; since?: string }) {
  const app = useApp();
  const found = useLoad(() => app.read<Archive>("points.list", { q, ...(since ? { since } : {}), limit: 60 }), [q, since]);
  const rows = app.use(() => (found.data?.sessions ?? []).map((s) => seen(app, s)).filter((s) => !project || s.project === project));
  if (found.error) return <Note tone="bad">{`Поиск не прошёл: ${refused(found.error)}`}</Note>;
  if (!found.data) return <Note>…</Note>;
  const groups: Hit[][] = rows.map((s) => (s.hits ?? []).map((h) => ({ ...h, sid: s.sid, callsign: s.callsign ?? s.sid, title: titleOf(s) }))).filter((g) => g.length);
  return (
    <Sec data-hits="" className="ss-list">
      {!groups.length && <Note>Ничего не нашлось.</Note>}
      {groups.map((hits) => (
        <div key={hits[0].sid} className="ss-group" data-sid={hits[0].sid}>
          <span className="ss-hh">
            <span className="ss-title">{hits[0].title}</span>
            <M>{hits[0].callsign}</M>
            <span className="ss-when">{day(Date.parse(hits[0].at))}</span>
          </span>
          {hits.map((h) => (
            <button key={h.uuid} type="button" className="ss-hit" data-hit={h.uuid} onClick={() => app.open("points", { sid: h.sid, point: String(h.point), uuid: h.uuid, q })}>
              <span className="ss-when">{hhmm(Date.parse(h.at))}</span>
              <span className="ss-txt">{mark(h.text, q)}</span>
            </button>
          ))}
        </div>
      ))}
    </Sec>
  );
}

export function List() {
  const app = useApp();
  const fleet = useModule<Fleet>();
  const all = app.use(() => (fleet.get().fleet?.sessions ?? []).map((s) => seen(app, s)));
  const online = app.use(() => (app.roster()?.machines ?? []).map((m) => m.machine));
  const [project, setProject] = useState("");
  const [period, setPeriod] = useState("week");
  const [order, setOrder] = useState("last");
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState("");
  const since = sinceOf(period);
  const list = useLoad(() => app.read<Archive>("points.list", { ...(since ? { since } : {}), order }), [period, order]);
  // хранилище без поиска — поля поиска нет
  const canSearch = list.data?.search === true;
  useEffect(() => void fleet.read(), [fleet]);
  const projects = [...new Set(all.map((s) => s.project).filter((p): p is string => !!p))].sort();
  const lost = all.filter((s) => online.length && !online.includes(s.owner));
  const machines = [...new Set(lost.map((s) => s.owner))];
  const rows = app.use(() => (list.data?.sessions ?? []).map((s) => seen(app, s)).filter((s) => !project || s.project === project));
  return (
    <Page className="ss-page">
      <PageHead title="Сессии">
        {canSearch ? (
          <form
            className="ss-q"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              setAsked(q.trim());
            }}
          >
            <In data-f="q" type="search" placeholder="⌕ поиск по переписке" aria-label="Поиск по переписке" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
            {asked ? (
              <Btn
                type="button"
                onClick={() => {
                  setQ("");
                  setAsked("");
                }}
              >
                Сбросить
              </Btn>
            ) : (
              <Btn pri type="submit" disabled={!q.trim()}>
                Найти
              </Btn>
            )}
          </form>
        ) : null}
      </PageHead>
      {machines.map((m) => (
        <Fire key={m} machine={m} sessions={lost.filter((s) => s.owner === m)} fleet={fleet} />
      ))}
      <Opts className="ss-filters">
        {projects.length > 1 ? <Picks f="project" label="Проект" value={project} set={setProject} data={[["", "все проекты"], ...projects.map((p): [string, string] => [p, p])]} /> : null}
        <Picks f="period" label="Период" value={period} set={setPeriod} data={PERIODS} />
        {asked ? null : <Picks f="order" label="Порядок" value={order} set={setOrder} data={ORDERS} />}
      </Opts>
      {asked ? (
        <Hits q={asked} project={project} since={since} />
      ) : list.error ? (
        <Note tone="bad" role="alert">{`Архив не загрузился: ${refused(list.error)}`}</Note>
      ) : !list.data ? (
        <Note>…</Note>
      ) : (
        <Sec data-archive="" className="ss-list">
          {rows.length ? rows.map((s) => <SessionRow key={s.sid} s={s} />) : <Note>За этот период сессий нет.</Note>}
        </Sec>
      )}
    </Page>
  );
}
