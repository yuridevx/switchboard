// Шапка экрана и полоса «Нет связи».
import { Dot, hhmm, IconBtn, Pill, TextBtn, useNow } from "@switchboard/web-ui";
import type { Head } from "../types.ts";
import { connPill, useCore } from "./context.ts";

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <circle cx="11" cy="11" r="6" />
    <path d="m16 16 4 4" />
  </svg>
);

/** Что показать в шапке: простые данные; действие берётся заново при нажатии. */
function useBarModel(ready: boolean) {
  const { snap, modules, sections } = useCore();
  return snap.use(() => {
    const { current, conn, rosterAt } = snap.get();
    const def = current ? modules.screens.get(current.screen)?.def : undefined;
    const head: Partial<Head> = current && ready ? sections.head(current.screen, current.params) : {};
    const off = conn !== "open";
    return {
      isSection: !!def?.nav,
      off,
      title: head.title ?? "",
      sub: conn === "closed" && rosterAt ? `данные на ${hhmm(rosterAt)}` : head.sub,
      pill: off ? connPill(conn) : (head.pill ?? (def?.nav ? connPill("open") : undefined)),
      dot: head.dot,
      mono: head.mono,
      action: head.action ? { label: head.action.label, text: head.action.text } : null,
    };
  });
}

export function Bar({ ready, openSearch }: { ready: boolean; openSearch(): void }) {
  const core = useCore();
  const v = useBarModel(ready);
  const runAction = () => {
    const c = core.snap.get().current;
    if (c) core.sections.head(c.screen, c.params).action?.run();
  };
  return (
    <header className="sb-bar" hidden={!ready}>
      {ready ? (
        <>
          {v.isSection ? (
            <div className="sb-logo" aria-hidden="true">
              S
            </div>
          ) : (
            <IconBtn className="sb-back" aria-label="Назад" onClick={core.address.back}>
              ‹
            </IconBtn>
          )}
          {v.dot ? <Dot kind={v.dot} /> : null}
          <div className="sb-bt">
            <b className={v.mono ? "m" : undefined}>{v.title}</b>
            {v.sub ? <span>{v.sub}</span> : null}
          </div>
          {!core.wide && v.isSection ? (
            <IconBtn className="sb-find" aria-label="Найти" data-find="1" onClick={openSearch}>
              <SearchIcon />
            </IconBtn>
          ) : null}
          {!core.wide && v.action ? (
            <IconBtn className="sb-find pri" aria-label={v.action.label} data-new="1" onClick={runAction}>
              {v.action.text}
            </IconBtn>
          ) : null}
          {v.pill ? (
            <Pill conn={v.off || v.isSection} tone={v.pill.tone ?? ""}>
              {v.pill.text}
            </Pill>
          ) : null}
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
  const dataAt = core.wide && rosterAt ? ` · данные на ${hhmm(rosterAt)}` : "";
  return (
    <>
      <span>{`Нет связи с relay${dataAt}${left > 0 ? ` · снова через ${left} с` : " · подключаюсь"}`}</span>
      <TextBtn onClick={core.link.reconnectNow}>Сейчас</TextBtn>
    </>
  );
}

/** Полоса «Нет связи»: когда снова и «Сейчас». */
export function Offline() {
  const { snap } = useCore();
  const { hidden, retryAt, rosterAt } = snap.use(() => {
    const st = snap.get();
    return { hidden: st.conn === "open" || st.retryAt === 0 || !!st.full, retryAt: st.retryAt, rosterAt: st.rosterAt };
  });
  return (
    <div className="sb-off" role="status" hidden={hidden}>
      {hidden ? null : <OfflineBody retryAt={retryAt} rosterAt={rosterAt} />}
    </div>
  );
}
