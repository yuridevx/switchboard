// Вид ядра: каркас страницы и экраны модулей в местах. Разделы — sections.tsx, шапка и полоса связи — bar.tsx, поиск — palette.tsx.
import { useEffect, useState, useSyncExternalStore } from "react";
import { UI_CSS } from "@switchboard/web-ui";
import css from "./shell.css";
import { Bar, Offline } from "./bar.tsx";
import { CoreCtx, useCore, type Core } from "./core.ts";
import { Palette } from "./palette.tsx";
import { Place } from "./place.tsx";
import { GroupRow, NavColumn, sectionsModel, Tabs } from "./sections.tsx";

/** Стили страницы: основание, вид ядра и стили модулей в их областях. */
export function pageCss(mods: Array<{ name: string; css: string }>): string {
  const scoped = mods.map((m) => `@scope ([data-module="${m.name}"]) to ([data-module]) {\n${m.css}\n}`);
  return [UI_CSS, css, ...scoped].join("\n");
}

/** Экран: на всю страницу, рядом со списком или один; пока нет roster — экран подключения. */
function Stage({ ready }: { ready: boolean }) {
  const core = useCore();
  const { full, current, master, connecting, fresh } = core.state();
  const pageKey = current ? `${current.screen}?${new URLSearchParams(current.params)}` : "";
  const screenEl = current ? (
    <div key={pageKey} className="sb-screen" data-screen={current.screen} style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <Place screen={current.screen} params={current.params} />
    </div>
  ) : null;
  return (
    <div className="sb-view">
      {full ? (
        <div className="sb-full">{full}</div>
      ) : ready ? (
        master ? (
          <div className="sb-split">
            <div className="sb-master" data-screen={master}>
              <Place screen={master} />
            </div>
            <div className="sb-detail">{screenEl}</div>
          </div>
        ) : (
          screenEl
        )
      ) : connecting ? (
        <div className="sb-full">
          <div className="sb-logo xl">S</div>
          {fresh ? <div className="sb-big">Ключ сохранён</div> : null}
          <span className="sb-k">{core.keyLabel()}</span>
          <p>подключаюсь · hello</p>
        </div>
      ) : null}
    </div>
  );
}

/** Ctrl K в широком виде и открытие поиска: пока приложение работает. */
function usePalette(core: Core) {
  const [open, setOpen] = useState(false);
  const canOpen = () => {
    const { stopped, roster } = core.state();
    return !stopped && !!roster;
  };
  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (!core.wide || !(e.ctrlKey || e.metaKey) || !(e.code === "KeyK" || e.key === "k" || e.key === "л")) return;
      e.preventDefault();
      if (canOpen()) setOpen((v) => !v);
    };
    const doc = core.win.document;
    doc.addEventListener("keydown", keys as EventListener);
    return () => doc.removeEventListener("keydown", keys as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [core]);
  return { open, close: () => setOpen(false), show: () => void (canOpen() && setOpen(true)) };
}

function Shell() {
  const core = useCore();
  // вид ядра маленький: перерисовывается на каждое изменение и читает всё заново
  useSyncExternalStore(core.subscribe, core.rev, core.rev);
  const pal = usePalette(core);
  const { stopped, roster, current, master, tops, toast } = core.state();
  const ready = !!roster && !!current && !stopped;
  const def = current ? core.lookup(current.screen)?.def : undefined;
  const model = sectionsModel(core);
  return (
    <div className={"sb-app" + (core.wide ? " wide" : "")}>
      <NavColumn model={model} openPal={pal.show} />
      <main className="sb-main">
        <Bar ready={ready} openPal={pal.show} />
        <GroupRow model={model} ready={ready} />
        <Offline />
        <div className="sb-top" hidden={!ready || (!def?.nav && !master)}>
          {tops.map((n) => (
            <div key={n}>
              <Place screen={n} />
            </div>
          ))}
        </div>
        <Stage ready={ready} />
        <div className={"sb-toast " + (toast?.tone ?? "")} role="alert" hidden={!toast?.shown}>
          {toast?.text}
        </div>
        <Tabs model={model} />
      </main>
      <div className="sb-palw" hidden={!pal.open}>
        {pal.open ? <Palette close={pal.close} /> : null}
      </div>
    </div>
  );
}

/** Корень страницы: стили и каркас. */
export function Root({ core }: { core: Core }) {
  const text = core.use(() => core.state().css);
  return (
    <CoreCtx.Provider value={core}>
      <style>{text}</style>
      <Shell />
    </CoreCtx.Provider>
  );
}
