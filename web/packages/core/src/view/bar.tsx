// Шапка экрана, полоса «Нет связи» и лампа связи.
import { Dot, hhmm, IconBtn, Pill, TextBtn, useNow } from "@switchboard/web-ui";
import type { Head } from "../types.ts";
import { useCore } from "./place.tsx";

const WORDS = {
  open: ["на связи", "ok"],
  closed: ["нет связи", "bad"],
  stopped: ["нет связи", "bad"],
  connecting: ["подключаюсь", "wait"],
} as const;

/** Лампа связи; bare — без слов, с подсказкой. */
export function ConnPill({ bare }: { bare?: boolean }) {
  const { page } = useCore();
  const [text, tone] = WORDS[page.use(() => page.link)];
  return bare ? <Pill tone={tone} conn title={text} aria-label={text} /> : <Pill tone={tone} conn>{text}</Pill>;
}

const Find = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

/** Шапка открытого экрана: что показывать. */
function useHead() {
  const { page, mods } = useCore();
  return page.use(() => {
    const cur = page.current;
    if (!cur || page.stop) return null;
    const s = mods.screens.get(cur.screen)!;
    const head: Partial<Head> = mods.call(s.mod, `шапке ${s.name}`, () => s.def.head?.(cur.params)) ?? {};
    const offline = page.link !== "open";
    return {
      ...head,
      title: head.title ?? s.def.label ?? s.def.nav ?? "",
      sub: offline && page.dataAt ? `данные на ${hhmm(new Date(page.dataAt))}` : head.sub,
      section: !!s.def.nav && !s.def.place,
      offline,
    };
  });
}

export function Bar() {
  const { page, route } = useCore();
  const h = useHead();
  if (!h) return <header className="sb-bar" hidden />;
  return (
    <header className="sb-bar">
      {h.section ? (
        <div className="sb-logo" aria-hidden="true">
          S
        </div>
      ) : (
        <IconBtn className="sb-back" aria-label="Назад" onClick={route.back}>
          ‹
        </IconBtn>
      )}
      {h.dot && <Dot kind={h.dot} />}
      <div className="sb-bt">
        <b className={h.mono ? "m" : undefined}>{h.title}</b>
        {h.sub && <span>{h.sub}</span>}
      </div>
      {h.section && !page.wide && (
        <IconBtn className="sb-find" aria-label="Найти" data-find="1" onClick={() => ((page.search = true), page.changed())}>
          <Find />
        </IconBtn>
      )}
      {h.section && !page.wide && h.action && (
        <IconBtn className="sb-find pri" aria-label={h.action.label} data-new="1" onClick={h.action.run}>
          {h.action.text}
        </IconBtn>
      )}
      {h.pill && !h.offline ? <Pill tone={h.pill.tone}>{h.pill.text}</Pill> : (h.section || h.offline) && <ConnPill />}
    </header>
  );
}

function OffText() {
  const { page } = useCore();
  const now = useNow(1000);
  const { retryAt, dataAt } = page.use(() => ({ retryAt: page.down?.retryAt ?? 0, dataAt: page.dataAt }));
  const left = Math.ceil((retryAt - now) / 1000);
  const parts = ["Нет связи с relay", page.wide && dataAt ? `данные на ${hhmm(new Date(dataAt))}` : "", left > 0 ? `снова через ${left} с` : "подключаюсь"];
  return <span>{parts.filter(Boolean).join(" · ")}</span>;
}

/** Полоса: связи нет, а страница работает. */
export function Off() {
  const { page, link } = useCore();
  const shown = page.use(() => !!page.down && !page.stop);
  return (
    <div className="sb-off" role="status" hidden={!shown}>
      {shown && <OffText />}
      {shown && <TextBtn onClick={link.now}>Сейчас</TextBtn>}
    </div>
  );
}
