// Вид ядра: каркас страницы и экраны модулей в местах.
import { useEffect, useState } from "react";
import { UI_CSS } from "@switchboard/web-ui";
import css from "./shell.css";
import { Bar, Offline } from "./bar.tsx";
import { CoreCtx, useCore, type Core } from "./context.ts";
import { Place } from "./place.tsx";
import { Search } from "./search.tsx";
import { GroupRow, NavColumn, Tabs, useLayout } from "./sections.tsx";
import { StopScreen } from "./stops.tsx";
import { keyId } from "../pass.ts";

/** Стили страницы: основание, вид ядра и стили модулей в их областях. */
export function pageCss(mods: Array<{ name: string; css: string }>): string {
  const scoped = mods.map((m) => `@scope ([data-module="${m.name}"]) to ([data-module]) {\n${m.css}\n}`);
  return [UI_CSS, css, ...scoped].join("\n");
}

/** Экран подключения: пока нет roster. */
function Connecting({ fresh, passId }: { fresh: boolean; passId: string }) {
  return (
    <div className="sb-full">
      <div className="sb-logo xl">S</div>
      {fresh ? <div className="sb-big">Ключ сохранён</div> : null}
      <span className="sb-k">{passId}</span>
      <p>подключаюсь · hello</p>
    </div>
  );
}

/** Экран: на всю страницу, рядом со списком или один. */
function Stage({ ready }: { ready: boolean }) {
  const { snap } = useCore();
  const { full, current, master, connecting, fresh, passId } = snap.use(() => {
    const st = snap.get();
    return { full: st.full, current: st.current, master: st.master, connecting: !!st.key && !st.roster, fresh: st.fresh, passId: keyId(st.key) };
  });
  const screen = current ? (
    <div className="sb-screen" data-screen={current.screen} style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <Place screen={current.screen} params={current.params} />
    </div>
  ) : null;
  if (full) {
    return (
      <div className="sb-view">
        <div className="sb-full">
          <StopScreen stop={full} />
        </div>
      </div>
    );
  }
  return (
    <div className="sb-view">
      {ready && master ? (
        <div className="sb-split">
          <div className="sb-master" data-screen={master}>
            <Place screen={master} />
          </div>
          <div className="sb-detail">{screen}</div>
        </div>
      ) : ready ? (
        screen
      ) : connecting ? (
        <Connecting fresh={fresh} passId={passId} />
      ) : null}
    </div>
  );
}

/** Ctrl K в широком виде и открытие поиска: пока приложение работает. */
function useSearchBox({ wide, win, snap }: Core) {
  const [open, setOpen] = useState(false);
  const canOpen = () => {
    const { full, roster } = snap.get();
    return !full && !!roster;
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!wide || !(e.ctrlKey || e.metaKey) || !(e.code === "KeyK" || e.key === "k" || e.key === "л")) return;
      e.preventDefault();
      if (canOpen()) setOpen((v) => !v);
    };
    const doc = win.document;
    doc.addEventListener("keydown", onKey as EventListener);
    return () => doc.removeEventListener("keydown", onKey as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wide, win]);
  return { open, close: () => setOpen(false), show: () => void (canOpen() && setOpen(true)) };
}

/** Полоса над экранами разделов. */
function TopPlaces({ ready }: { ready: boolean }) {
  const { snap, modules } = useCore();
  const { shown, tops } = snap.use(() => {
    const { current, master, tops: names } = snap.get();
    const def = current ? modules.screens.get(current.screen)?.def : undefined;
    return { shown: ready && (!!def?.nav || !!master), tops: names };
  });
  return (
    <div className="sb-top" hidden={!shown}>
      {tops.map((n) => (
        <div key={n}>
          <Place screen={n} />
        </div>
      ))}
    </div>
  );
}

function ToastLine() {
  const { snap } = useCore();
  const toast = snap.use(() => snap.get().toast);
  return (
    <div className={`sb-toast ${toast?.tone ?? ""}`} role="alert" hidden={!toast?.shown}>
      {toast?.text}
    </div>
  );
}

function Shell() {
  const core = useCore();
  const search = useSearchBox(core);
  const ready = core.snap.use(() => {
    const { full, roster, current } = core.snap.get();
    return !!roster && !!current && !full;
  });
  const layout = useLayout();
  return (
    <div className={core.wide ? "sb-app wide" : "sb-app"}>
      <NavColumn layout={layout} openSearch={search.show} />
      <main className="sb-main">
        <Bar ready={ready} openSearch={search.show} />
        <GroupRow layout={layout} ready={ready} />
        <Offline />
        <TopPlaces ready={ready} />
        <Stage ready={ready} />
        <ToastLine />
        <Tabs layout={layout} />
      </main>
      <div className="sb-palw" hidden={!search.open}>
        {search.open ? <Search close={search.close} /> : null}
      </div>
    </div>
  );
}

/** Корень страницы: стили и каркас. */
export function Root({ core }: { core: Core }) {
  const text = core.snap.use(() => core.snap.get().css);
  return (
    <CoreCtx.Provider value={core}>
      <style>{text}</style>
      <Shell />
    </CoreCtx.Provider>
  );
}
