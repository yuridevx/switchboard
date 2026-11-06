// Шапка экрана, полоса «Нет связи» и лампа связи.
import { Dot, hhmm, IconBtn, Pill, TextBtn, useNow } from "@switchboard/web-ui";
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

const FIND = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <circle cx="11" cy="11" r="6" />
    <path d="m16 16 4 4" />
  </svg>
);

/** Шапка открытого экрана: данные выборки; действие раздела зовётся из свежей шапки. */
function useHead() {
  const { page, mods } = useCore();
  const head = () => {
    const { screen, params } = page.current!;
    const s = mods.screens.get(screen)!;
    return { s, h: mods.call(s.mod, `экране ${screen}`, () => s.def.head?.(params)) };
  };
  const view = page.use(() => {
    if (!page.current || page.stop) return null;
    const { s, h } = head();
    return {
      section: !!s.def.nav,
      title: h?.title ?? s.def.nav ?? s.def.label ?? "",
      sub: page.link === "closed" && page.dataAt ? `данные на ${hhmm(new Date(page.dataAt))}` : h?.sub,
      dot: h?.dot,
      mono: h?.mono,
      pill: h?.pill,
      action: h?.action && { label: h.action.label, text: h.action.text },
      own: page.link === "open" && !(!!s.def.nav && !h?.pill),
    };
  });
  const act = () => {
    const { s, h } = head();
    mods.call(s.mod, `экране ${s.name}`, () => h?.action?.run());
  };
  return { view, act };
}

export function Bar() {
  const { page, route } = useCore();
  const { view: h, act } = useHead();
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
        <IconBtn className="sb-find" data-find="1" aria-label="Найти" onClick={page.toggleSearch}>
          {FIND}
        </IconBtn>
      )}
      {h.section && !page.wide && h.action && (
        <IconBtn className="sb-find pri" data-new="1" aria-label={h.action.label} onClick={act}>
          {h.action.text}
        </IconBtn>
      )}
      {h.own ? h.pill && <Pill tone={h.pill.tone}>{h.pill.text}</Pill> : <ConnPill />}
    </header>
  );
}

/** Полоса «Нет связи»: когда снова — обратным отсчётом. */
export function Off() {
  const { page, link } = useCore();
  const v = page.use(() => (page.down && !page.stop ? { retryAt: page.down.retryAt, at: page.wide ? page.dataAt : 0 } : null));
  useNow(v ? 1000 : 0);
  const left = v ? Math.ceil((v.retryAt - Date.now()) / 1000) : 0;
  return (
    <div className="sb-off" role="status" hidden={!v}>
      {v && <span>{["Нет связи с relay", v.at && `данные на ${hhmm(new Date(v.at))}`, left > 0 ? `снова через ${left} с` : "подключаюсь"].filter(Boolean).join(" · ")}</span>}
      {v && <TextBtn onClick={link.now}>Сейчас</TextBtn>}
    </div>
  );
}
