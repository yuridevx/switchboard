// Лента сессии из архива: записи точки (points.history) той же свёрткой и теми же строками, что живая лента; только чтение.
// Параметры: sid, point (нет — голова), callsign — подпись строк; marks — точки на своих местах «id:записей:чч:мм,…»,
// sel — выбранная точка: разговор после неё приглушён; pick=1 — точки кнопками: клик ловит владелец страницы по data-mark;
// uuid — найденная запись: лента открывается на ней, q — найденные слова подсвечиваются внутри неё.
import { Fragment, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Btn, useApp, type Params } from "@switchboard/web-ui";
import { focused } from "../focus.ts";
import { fold, type Msg } from "../fold.ts";
import { EnvCtx, type Env } from "./env.ts";
import { ItemView } from "./Screen.tsx";

const PAGE = 200;
const quiet = () => {};
const HIT = "chat-q";

type Page = { messages: Msg[]; more: boolean; point: number };
type Mark = { id: string; n: number; at: string };

const marksOf = (s = ""): Mark[] =>
  s
    .split(",")
    .filter(Boolean)
    .map((x) => {
      const [id, n, ...at] = x.split(":");
      return { id, n: Number(n), at: at.join(":") };
    });

/** Подсветка слов q внутри найденной записи — CSS Custom Highlight, без правки DOM. */
function useHighlight(box: RefObject<HTMLDivElement | null>, uuid: string, q: string, ready: boolean) {
  useEffect(() => {
    const reg = (globalThis.CSS as { highlights?: Map<string, unknown> } | undefined)?.highlights;
    const el = box.current?.querySelector(`[data-at="${uuid}"]`);
    if (!reg || !el || !q || !ready || typeof Highlight === "undefined") return;
    const want = q.toLowerCase();
    const ranges: Range[] = [];
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      const text = (node.textContent ?? "").toLowerCase();
      for (let i = text.indexOf(want); i >= 0; i = text.indexOf(want, i + want.length)) {
        const r = new Range();
        r.setStart(node, i);
        r.setEnd(node, i + want.length);
        ranges.push(r);
      }
    }
    reg.set(HIT, new Highlight(...ranges));
    return () => void reg.delete(HIT);
  }, [box, uuid, q, ready]);
}

export function ArchiveScreen({ params }: { params: Params }) {
  const app = useApp();
  const { sid, callsign = "", uuid = "", q = "", sel = "", pick = "" } = params;
  const pickable = pick === "1";
  const point = params.point ? Number(params.point) : undefined;
  const marks = useMemo(() => marksOf(params.marks), [params.marks]);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  async function page(before: string | null) {
    const r = await app.read<Page>("points.history", { sid, ...(point ? { point } : {}), before, limit: PAGE });
    if (!r.ok) return setError(r.error);
    setMsgs((was) => (before ? [...r.result.messages, ...was] : r.result.messages));
    setMore(r.result.more);
    setLoaded(true);
  }

  useEffect(() => void page(null), [sid, point]); // eslint-disable-line react-hooks/exhaustive-deps

  const view = useMemo(() => fold(msgs), [msgs]);
  const items = useMemo(() => focused(view), [view]);
  // место записи в разговоре: точка с n записями стоит перед первой записью с номером ≥ n; строка ответа ленты названа id сообщения
  // модели, а не uuid записи, — её место по первой записи этого сообщения
  const index = useMemo(() => {
    const at = new Map<string, number>();
    msgs.forEach((m, i) => {
      at.set(String(m.uuid ?? ""), i);
      const id = (m.message as { id?: unknown } | undefined)?.id;
      if (typeof id === "string" && !at.has(id)) at.set(id, i);
    });
    return at;
  }, [msgs]);
  // ключ строки ленты — запись или сообщение, у свёрток — с приставкой steps- и хвостом -final или -open;
  // строки без своей записи (служебные) — на месте предыдущей
  const places = useMemo(() => {
    let last = 0;
    return items.map((it) => (last = index.get(it.key.split(":")[0].replace(/^steps-/, "").replace(/-(final|open)$/, "")) ?? last));
  }, [items, index]);
  const cut = marks.find((m) => m.id === sel)?.n ?? Infinity;
  // найденная запись может быть внутри свёрнутого шага: отмечаем строку ленты, в которой она лежит
  const hitAt = useMemo(() => {
    const want = index.get(uuid);
    if (want === undefined) return "";
    let at = "";
    items.forEach((it, n) => {
      if (places[n] <= want) at = it.key.split(":")[0];
    });
    return at;
  }, [items, index, places, uuid]);
  useEffect(() => {
    if (!loaded) return;
    const at = hitAt ? box.current?.querySelector(`[data-at="${hitAt}"]`) : sel ? box.current?.querySelector(`[data-mark="${sel}"]`) : null;
    at?.scrollIntoView({ block: "center" });
  }, [hitAt, sel, loaded]);
  useHighlight(box, hitAt, q, loaded);

  const env: Env = { cs: callsign || sid, wide: app.wide, canAct: false, view, sends: {}, rewind: null, label: callsign.split("@")[0] || "сессия", waiting: () => false, act: quiet, again: quiet, cancel: quiet, probe: quiet, apply: quiet, cancelRewind: quiet, fill: quiet };
  const Point = ({ m }: { m: Mark }) =>
    pickable ? (
      <button type="button" className="chat-pt" data-mark={m.id} aria-pressed={m.id === sel}>
        {`№${m.id} · ${m.at}`}
      </button>
    ) : (
      <div className="chat-pt" data-mark={m.id}>{`№${m.id} · ${m.at}`}</div>
    );
  let next = 0;
  return (
    <EnvCtx.Provider value={env}>
      <div className={app.wide ? "chat wide chat-archive" : "chat chat-archive"} ref={box} data-archive={sid}>
        <div className="chat-col">
          {more ? (
            <Btn type="button" className="chat-older" onClick={() => void page(String(msgs[0]?.uuid ?? ""))}>
              Раньше
            </Btn>
          ) : null}
          {items.map((it, n) => {
            const at = it.key.split(":")[0];
            const i = places[n];
            const before: Mark[] = [];
            while (next < marks.length && marks[next].n <= i) before.push(marks[next++]);
            return (
              <Fragment key={it.key}>
                {before.map((m) => (
                  <Point key={m.id} m={m} />
                ))}
                <div data-at={at} className={`chat-at${hitAt && at === hitAt ? " hit" : ""}${i >= cut ? " after" : ""}`}>
                  <ItemView it={it} />
                </div>
              </Fragment>
            );
          })}
          {loaded
            ? marks.slice(next).map((m) => (
                <Point key={m.id} m={m} />
              ))
            : null}
          {error ? (
            <div className="chat-note" role="alert">
              {`Разговор не загрузился: ${error}`}
            </div>
          ) : loaded && !view.rows.length ? (
            <div className="chat-note">На этой точке разговора ещё нет</div>
          ) : !loaded ? (
            <div className="chat-note">…</div>
          ) : null}
        </div>
      </div>
    </EnvCtx.Provider>
  );
}
