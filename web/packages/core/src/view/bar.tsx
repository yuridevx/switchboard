// Шапка экрана и полоса «Нет связи».
import { Dot, hhmm, IconBtn, Pill, TextBtn, useNow } from "@switchboard/web-ui";
import type { Head } from "../types.ts";
import { connPill, useCore } from "./core.ts";

export function Bar({ ready, openPal }: { ready: boolean; openPal(): void }) {
  const core = useCore();
  // шапка экрана — простые данные; действие берётся заново при нажатии
  const v = core.use(() => {
    const { current, conn, rosterAt } = core.state();
    const def = current ? core.lookup(current.screen)?.def : undefined;
    const head: Partial<Head> = current && ready ? core.head(current.screen, current.params) : {};
    let pill: Head["pill"] = head.pill ?? (def?.nav ? connPill("open") : undefined);
    let sub = head.sub;
    if (conn !== "open") {
      pill = connPill(conn);
      if (conn === "closed" && rosterAt) sub = `данные на ${hhmm(rosterAt)}`;
    }
    return { nav: !!def?.nav, off: conn !== "open", title: head.title ?? "", sub, pill, dot: head.dot, mono: head.mono, action: head.action ? { label: head.action.label, text: head.action.text } : null };
  });
  const runAction = () => {
    const c = core.state().current;
    if (c) core.head(c.screen, c.params).action?.run();
  };
  return (
    <header className="sb-bar" hidden={!ready}>
      {ready ? (
        <>
          {v.nav ? (
            <div className="sb-logo" aria-hidden="true">
              S
            </div>
          ) : (
            <IconBtn className="sb-back" aria-label="Назад" onClick={core.back}>
              ‹
            </IconBtn>
          )}
          {v.dot ? <Dot kind={v.dot} /> : null}
          <div className="sb-bt">
            <b className={v.mono ? "m" : undefined}>{v.title}</b>
            {v.sub ? <span>{v.sub}</span> : null}
          </div>
          {!core.wide && v.nav ? (
            <IconBtn className="sb-find" aria-label="Найти" data-find="1" onClick={openPal}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="11" cy="11" r="6" />
                <path d="m16 16 4 4" />
              </svg>
            </IconBtn>
          ) : null}
          {!core.wide && v.action ? (
            <IconBtn className="sb-find pri" aria-label={v.action.label} data-new="1" onClick={runAction}>
              {v.action.text}
            </IconBtn>
          ) : null}
          {v.pill ? <Pill conn={v.off || v.nav} tone={v.pill.tone ?? ""}>{v.pill.text}</Pill> : null}
        </>
      ) : null}
    </header>
  );
}

/** Текст и кнопка полосы: отсчёт идёт, только пока она видна. */
function OfflineBody({ retryAt, rosterAt }: { retryAt: number; rosterAt: number }) {
  const core = useCore();
  const now = useNow(1_000);
  const left = Math.max(0, Math.ceil((retryAt - now) / 1000));
  return (
    <>
      <span>{`Нет связи с relay${core.wide && rosterAt ? ` · данные на ${hhmm(rosterAt)}` : ""}${left > 0 ? ` · снова через ${left} с` : " · подключаюсь"}`}</span>
      <TextBtn onClick={core.reconnectNow}>Сейчас</TextBtn>
    </>
  );
}

/** Полоса «Нет связи»: когда снова и «Сейчас». */
export function Offline() {
  const core = useCore();
  const { hidden, retryAt, rosterAt } = core.use(() => {
    const { conn, retryAt: at, full, rosterAt: t } = core.state();
    return { hidden: conn === "open" || at === 0 || !!full, retryAt: at, rosterAt: t };
  });
  return (
    <div className="sb-off" role="status" hidden={hidden}>
      {hidden ? null : <OfflineBody retryAt={retryAt} rosterAt={rosterAt} />}
    </div>
  );
}
