// Шапка экрана и полоса «Нет связи».
import { Dot, hhmm, Pill } from "@switchboard/web-ui";
import type { Head } from "../types.ts";
import { useCore } from "./core.ts";

export function Bar({ ready, openPal }: { ready: boolean; openPal(): void }) {
  const core = useCore();
  const { current, conn, rosterAt } = core.state();
  const def = current ? core.lookup(current.screen)?.def : undefined;
  const hd = current && ready ? core.head(current.screen, current.params) : { title: "" as string, sub: undefined as string | undefined };
  const head = hd as Head;
  let pill = head.pill ?? (def?.nav ? { text: "на связи", tone: "ok" as const } : undefined);
  let sub = head.sub;
  if (conn !== "open") {
    pill = conn === "closed" ? { text: "нет связи", tone: "bad" as const } : { text: "подключаюсь", tone: "wait" as const };
    if (conn === "closed" && rosterAt) sub = `данные на ${hhmm(rosterAt)}`;
  }
  return (
    <header className="sb-bar" hidden={!ready}>
      {ready ? (
        <>
          {def?.nav ? (
            <div className="sb-logo" aria-hidden="true">
              S
            </div>
          ) : (
            <button className="sb-back" aria-label="Назад" onClick={core.back}>
              ‹
            </button>
          )}
          {head.dot ? <Dot kind={head.dot} /> : null}
          <div className="sb-bt">
            <b className={head.mono ? "m" : undefined}>{head.title}</b>
            {sub ? <span>{sub}</span> : null}
          </div>
          {!core.wide && def?.nav ? (
            <button className="sb-find" aria-label="Найти" data-find="1" onClick={openPal}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="11" cy="11" r="6" />
                <path d="m16 16 4 4" />
              </svg>
            </button>
          ) : null}
          {!core.wide && head.action ? (
            <button className="sb-find pri" aria-label={head.action.label} data-new="1" onClick={head.action.run}>
              {head.action.text}
            </button>
          ) : null}
          {pill ? <Pill conn={conn !== "open" || !!def?.nav} tone={pill.tone ?? ""}>{pill.text}</Pill> : null}
        </>
      ) : null}
    </header>
  );
}

/** Полоса «Нет связи»: когда снова и «Сейчас». */
export function Offline() {
  const core = useCore();
  const { conn, retryAt, stopped, rosterAt } = core.state();
  const hidden = conn === "open" || retryAt === 0 || stopped !== null;
  const left = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
  return (
    <div className="sb-off" role="status" hidden={hidden}>
      {hidden ? null : (
        <>
          <span>{`Нет связи с relay${core.wide && rosterAt ? ` · данные на ${hhmm(rosterAt)}` : ""}${left > 0 ? ` · снова через ${left} с` : " · подключаюсь"}`}</span>
          <button onClick={core.reconnectNow}>Сейчас</button>
        </>
      )}
    </div>
  );
}
