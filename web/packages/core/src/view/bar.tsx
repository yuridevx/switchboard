// Шапка экрана и полоса связи.
import { Dot, hhmm, IconBtn, Pill, TextBtn, useNow } from "@switchboard/web-ui";
import type { Head } from "../types.ts";
import { linkPill } from "./nav.tsx";
import type { Page } from "./shell.tsx";

/** Что шапка рисует: данные выборки; действие раздела зовётся из свежей шапки. */
function headOf({ core, modules }: Page) {
  if (!core.current || core.stopped !== null) return null;
  const { screen: name, params } = core.current;
  const found = modules.screenOf(name);
  if (!found) return null;
  const [e, s] = found;
  const head = s.head && !modules.off(e) ? modules.trap<Head | undefined>(e, `экране ${name}`, () => s.head!(params)) : undefined;
  return {
    section: !!s.nav,
    title: head?.title ?? s.nav ?? s.label ?? "",
    sub: head?.sub,
    dot: head?.dot,
    mono: head?.mono,
    pill: head?.pill,
    action: head?.action && { label: head.action.label, text: head.action.text },
  };
}

function runAction(page: Page) {
  const { screen, params } = page.core.current!;
  const [e, s] = page.modules.screenOf(screen)!;
  page.modules.trap(e, `экране ${screen}`, () => s.head?.(params).action?.run());
}

const FIND = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <circle cx="11" cy="11" r="6" />
    <path d="m16 16 4 4" />
  </svg>
);

export function Bar({ page }: { page: Page }) {
  const { core, bus, wide } = page;
  const head = bus.use(() => headOf(page));
  const link = bus.use(() => core.link);
  const at = bus.use(() => (link === "closed" ? core.rosterAt : null));
  if (!head) return <header className="sb-bar" hidden />;
  const coreOwn = link === "open" ? head.section && !head.pill : true;
  const shown = linkPill(link);
  return (
    <header className="sb-bar">
      {head.section ? (
        <div className="sb-logo" aria-hidden="true">
          S
        </div>
      ) : (
        <IconBtn className="sb-back" aria-label="Назад" onClick={page.back}>
          ‹
        </IconBtn>
      )}
      {head.dot && <Dot kind={head.dot} />}
      <div className="sb-bt">
        <b className={head.mono ? "m" : undefined}>{head.title}</b>
        {at ? <span>{`данные на ${hhmm(at)}`}</span> : head.sub && <span>{head.sub}</span>}
      </div>
      {head.section && !wide && (
        <>
          <IconBtn className="sb-find" data-find="1" aria-label="Найти" onClick={page.search}>
            {FIND}
          </IconBtn>
          {head.action && (
            <IconBtn className="sb-find pri" data-new="1" aria-label={head.action.label} onClick={() => runAction(page)}>
              {head.action.text}
            </IconBtn>
          )}
        </>
      )}
      {coreOwn ? (
        <Pill tone={shown.tone} conn>
          {shown.text}
        </Pill>
      ) : (
        head.pill && <Pill tone={head.pill.tone}>{head.pill.text}</Pill>
      )}
    </header>
  );
}

/** Полоса «Нет связи»: когда снова — обратным отсчётом. */
export function Off({ page }: { page: Page }) {
  const { core, bus, wide } = page;
  const lost = bus.use(() => core.lost);
  const at = bus.use(() => (wide ? core.rosterAt : null));
  useNow(lost ? 1000 : 0);
  const left = lost ? Math.ceil((lost.retryAt - Date.now()) / 1000) : 0;
  return (
    <div className="sb-off" role="status" hidden={!lost}>
      {lost && (
        <>
          <span>{["Нет связи с relay", at && `данные на ${hhmm(at)}`, left > 0 ? `снова через ${left} с` : "подключаюсь"].filter(Boolean).join(" · ")}</span>
          <TextBtn onClick={page.now}>Сейчас</TextBtn>
        </>
      )}
    </div>
  );
}
