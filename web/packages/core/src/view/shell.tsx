// Вид ядра: разделы, шапка, полоса связи, поиск Ctrl K, всплывающая строка; экраны модулей — в местах.
import { useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { Badge, Dot, hhmm, Pill, UI_CSS } from "@switchboard/web-ui";
import css from "./shell.css";
import type { Mod } from "../app.tsx";
import type { ConnState, Head, Params, Screen, SlotProps } from "../types.ts";
import type { Roster } from "@switchboard/relay";

export type Hit = { label: string; hint?: string; dot?: string; screen: string; params: Params };

/** То, что вид ядра читает у ядра. */
export type Core = {
  wide: boolean;
  brand?: string;
  win: Window;
  css(): string;
  subscribe(f: () => void): () => void;
  rev(): number;
  use<T>(select: () => T): T;
  Place: ComponentType<SlotProps>;
  full(): ReactNode;
  stopped(): string | null;
  connecting(): boolean;
  fresh(): boolean;
  keyLabel(): string;
  roster(): Roster | null;
  conn(): ConnState;
  rosterAt(): number;
  retryAt(): number;
  current(): { screen: string; params: Params } | null;
  master(): string | null;
  tops(): string[];
  toast(): { text: string; tone: "ok" | "bad"; shown: boolean } | null;
  lookup(screen: string): { owner: Mod; def: Screen } | undefined;
  head(screen: string, params: Params): Head;
  sections(): Array<[string, { owner: Mod; def: Screen }]>;
  countOf(s: { owner: Mod; def: Screen }): number | null;
  groupOf(d: Screen): string | undefined;
  hits(q: string): Hit[];
  go(screen: string, params: Params): void;
  back(): void;
  reconnectNow(): void;
};

/** Стили страницы: основание, вид ядра и стили модулей в их областях. */
export function pageCss(mods: Array<{ name: string; css: string }>): string {
  const scoped = mods.map((m) => `@scope ([data-module="${m.name}"]) to ([data-module]) {\n${m.css}\n}`);
  return [UI_CSS, css, ...scoped].join("\n");
}

function Palette({ core, close }: { core: Core; close(): void }) {
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const list = core.hits(q);
  const pick = (x: Hit) => {
    close();
    core.go(x.screen, x.params);
  };
  return (
    <>
      <div className="sb-palveil" onClick={close} />
      <div className="sb-pal" role="dialog" aria-label="Перейти">
        <input
          ref={input}
          className="sb-palin"
          placeholder="Сессия, проект, раздел или команда"
          aria-label="Перейти"
          value={q}
          onChange={() => {}}
          onInput={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && list[0]) {
              e.preventDefault();
              pick(list[0]);
            }
            if (e.key === "Escape") close();
          }}
        />
        <div className="sb-palres" role="listbox">
          {list.map((x, i) => (
            <button key={`${x.screen}?${JSON.stringify(x.params)}?${x.label}`} className={"sb-palit" + (i === 0 ? " first" : "")} role="option" onClick={() => pick(x)}>
              {x.dot ? <Dot kind={x.dot} /> : null}
              <span className="l">{x.label}</span>
              {x.hint ? <span className="k">{x.hint}</span> : null}
            </button>
          ))}
          {list.length ? null : (
            <div className="sb-note" style={{ padding: "10px 12px" }}>
              Ничего не нашлось
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** Кнопка раздела с меткой-счётчиком. */
function Item({ core, n, s, on }: { core: Core; n: string; s: { owner: Mod; def: Screen }; on: boolean }) {
  const count = core.countOf(s);
  return (
    <button className="sb-nv" aria-current={on ? "page" : undefined} data-screen={n} onClick={() => core.go(n, {})}>
      <span>{s.def.nav}</span>
      {count !== null ? <Badge wait>{count}</Badge> : null}
    </button>
  );
}

function Shell({ core }: { core: Core }) {
  // вид ядра маленький: перерисовывается на каждое изменение и читает всё заново
  useSyncExternalStore(core.subscribe, core.rev, core.rev);
  const [pal, setPal] = useState(false);
  const stopped = core.stopped();
  const full = core.full();
  const roster = core.roster();
  const wide = core.wide;
  const conn = core.conn();
  const current = core.current();
  const master = core.master();
  const ready = !!roster && !!current && !stopped;

  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (!wide || !(e.ctrlKey || e.metaKey) || !(e.code === "KeyK" || e.key === "k" || e.key === "л")) return;
      e.preventDefault();
      if (core.stopped() || !core.roster()) return;
      setPal((v) => !v);
    };
    const doc = core.win.document;
    doc.addEventListener("keydown", keys as EventListener);
    return () => doc.removeEventListener("keydown", keys as EventListener);
  }, [core, wide]);

  const openPal = () => {
    if (!core.stopped() && core.roster()) setPal(true);
  };

  const def = current ? core.lookup(current.screen)?.def : undefined;
  const hd = current && ready ? core.head(current.screen, current.params) : { title: "" as string, sub: undefined as string | undefined };
  const head = hd as Head;
  let pill = head.pill ?? (def?.nav ? { text: "на связи", tone: "ok" as const } : undefined);
  let sub = head.sub;
  if (conn !== "open") {
    pill = conn === "closed" ? { text: "нет связи", tone: "bad" as const } : { text: "подключаюсь", tone: "wait" as const };
    if (conn === "closed" && core.rosterAt()) sub = `данные на ${hhmm(core.rosterAt())}`;
  }

  const navs = roster ? core.sections() : [];
  const on = (n: string) => current?.screen === n || master === n;
  const groups = [...new Set(navs.map(([, s]) => core.groupOf(s.def)).filter((g): g is string => !!g))];
  const cp = conn === "open" ? { text: "на связи", tone: "ok" as const } : conn === "closed" ? { text: "нет связи", tone: "bad" as const } : { text: "подключаюсь", tone: "wait" as const };

  // узкий вид: вкладки внизу, группа — одной вкладкой, её разделы — лентой над экраном
  const solo = navs.filter(([, s]) => !core.groupOf(s.def));
  const tabCount = solo.length + groups.length;
  const openGroup = groups.find((g) => navs.some(([n, s]) => core.groupOf(s.def) === g && on(n)));
  const inOpen = openGroup ? navs.filter(([, s]) => core.groupOf(s.def) === openGroup) : [];
  const tabsShown = !wide && !!roster && tabCount >= 2;

  const offHidden = conn === "open" || core.retryAt() === 0 || stopped !== null;
  const left = Math.max(0, Math.ceil((core.retryAt() - Date.now()) / 1000));
  const toast = core.toast();

  const pageKey = current ? `${current.screen}?${new URLSearchParams(current.params)}` : "";
  const screenEl = current ? (
    <div key={pageKey} className="sb-screen" data-screen={current.screen} style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <core.Place screen={current.screen} params={current.params} />
    </div>
  ) : null;

  return (
    <div className={"sb-app" + (wide ? " wide" : "")}>
      <nav className="sb-navcol" hidden={!wide || !!full}>
        {wide && roster ? (
          <>
            <div className="sb-brand">
              <b>{core.brand ?? "Switchboard"}</b>
              <Pill conn tone={cp.tone} title={cp.text} aria-label={cp.text} />
            </div>
            <button className="sb-goto" onClick={openPal}>
              <span>Перейти…</span>
              <kbd>Ctrl K</kbd>
            </button>
            {solo.map(([n, s]) => (
              <Item key={n} core={core} n={n} s={s} on={on(n)} />
            ))}
            {groups.flatMap((g) => [
              <div key={`g:${g}`} className="sb-grp">
                {g}
              </div>,
              ...navs.filter(([, s]) => core.groupOf(s.def) === g).map(([n, s]) => <Item key={n} core={core} n={n} s={s} on={on(n)} />),
            ])}
          </>
        ) : null}
      </nav>
      <main className="sb-main">
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
              {!wide && def?.nav ? (
                <button className="sb-find" aria-label="Найти" data-find="1" onClick={openPal}>
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <circle cx="11" cy="11" r="6" />
                    <path d="m16 16 4 4" />
                  </svg>
                </button>
              ) : null}
              {!wide && head.action ? (
                <button className="sb-find pri" aria-label={head.action.label} data-new="1" onClick={head.action.run}>
                  {head.action.text}
                </button>
              ) : null}
              {pill ? <Pill conn={conn !== "open" || !!def?.nav} tone={pill.tone ?? ""}>{pill.text}</Pill> : null}
            </>
          ) : null}
        </header>
        <nav className="sb-navrow" hidden={wide || !ready || inOpen.length === 0}>
          {!wide && ready ? inOpen.map(([n, s]) => <Item key={n} core={core} n={n} s={s} on={on(n)} />) : null}
        </nav>
        <div className="sb-off" role="status" hidden={offHidden}>
          {offHidden ? null : (
            <>
              <span>{`Нет связи с relay${wide && core.rosterAt() ? ` · данные на ${hhmm(core.rosterAt())}` : ""}${left > 0 ? ` · снова через ${left} с` : " · подключаюсь"}`}</span>
              <button onClick={core.reconnectNow}>Сейчас</button>
            </>
          )}
        </div>
        <div className="sb-top" hidden={!ready || (!def?.nav && !master)}>
          {core.tops().map((n) => (
            <div key={n}>
              <core.Place screen={n} />
            </div>
          ))}
        </div>
        <div className="sb-view">
          {full ? (
            <div className="sb-full">{full}</div>
          ) : ready ? (
            master ? (
              <div className="sb-split">
                <div className="sb-master" data-screen={master}>
                  <core.Place screen={master} />
                </div>
                <div className="sb-detail">{screenEl}</div>
              </div>
            ) : (
              screenEl
            )
          ) : core.connecting() ? (
            <div className="sb-full">
              <div className="sb-logo xl">S</div>
              {core.fresh() ? <div className="sb-big">Ключ сохранён</div> : null}
              <span className="sb-k">{core.keyLabel()}</span>
              <p>подключаюсь · hello</p>
            </div>
          ) : null}
        </div>
        <div className={"sb-toast " + (toast?.tone ?? "")} role="alert" hidden={!toast?.shown}>
          {toast?.text}
        </div>
        <nav className="sb-tabs" aria-label="Разделы" hidden={!tabsShown}>
          {tabsShown ? (
            <>
              {solo.map(([n, s]) => (
                <Item key={n} core={core} n={n} s={s} on={on(n)} />
              ))}
              {groups.map((g) => {
                const inG = navs.filter(([, s]) => core.groupOf(s.def) === g);
                const cur = inG.some(([n]) => on(n));
                const count = inG.reduce((acc, [, s]) => acc + (core.countOf(s) ?? 0), 0);
                return (
                  <button key={`g:${g}`} className="sb-nv" aria-current={cur ? "page" : undefined} data-group={g} onClick={() => (cur ? null : core.go(inG[0][0], {}))}>
                    <span>{g}</span>
                    {count ? <Badge wait>{count}</Badge> : null}
                  </button>
                );
              })}
            </>
          ) : null}
        </nav>
      </main>
      <div className="sb-palw" hidden={!pal}>
        {pal ? <Palette core={core} close={() => setPal(false)} /> : null}
      </div>
    </div>
  );
}

/** Корень страницы: стили и каркас. */
export function Root({ core }: { core: Core }) {
  const text = core.use(core.css);
  return (
    <>
      <style>{text}</style>
      <Shell core={core} />
    </>
  );
}
