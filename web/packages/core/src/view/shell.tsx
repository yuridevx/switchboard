// Страница: остов разметки; всё, что на ней, читает состояние страницы выборкой.
import { UI_CSS } from "@switchboard/web-ui";
import type { Core } from "../app.ts";
import type { Pass } from "../pass.ts";
import { Bar, Off } from "./bar.tsx";
import { Column, Ribbon, Tabs } from "./nav.tsx";
import { CoreCtx, Place, useCore } from "./place.tsx";
import { Search } from "./search.tsx";
import css from "./shell.css";
import { Stops } from "./stops.tsx";

const FILL = { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 } as const;

function Screens() {
  const { page } = useCore();
  const cur = page.use(() => (page.stop ? null : page.current));
  if (!cur) return <Stops />;
  const screen = (
    <div className="sb-screen" data-screen={cur.screen} style={FILL}>
      <Place screen={cur.screen} params={cur.params} />
    </div>
  );
  if (!cur.master) return screen;
  return (
    <div className="sb-split">
      <div className="sb-master" data-screen={cur.master}>
        <Place screen={cur.master} />
      </div>
      <div className="sb-detail">{screen}</div>
    </div>
  );
}

/** Полоса над экранами разделов и над списком рядом; модули в ней живут и скрытые. */
function Top() {
  const { page, mods } = useCore();
  const started = page.use(() => page.started);
  const shown = page.use(() => {
    const c = page.current;
    return !!c && !page.stop && (!!c.master || !!mods.screens.get(c.screen)?.def.nav);
  });
  return (
    <div className="sb-top" hidden={!shown}>
      {started &&
        mods.tops().map((s) => (
          <div key={s.name}>
            <Place screen={s.name} />
          </div>
        ))}
    </div>
  );
}

function Toast() {
  const { page } = useCore();
  const t = page.use(() => page.toast);
  return (
    <div className={t.tone ? `sb-toast ${t.tone}` : "sb-toast"} role="alert" hidden={!t.shown}>
      {t.text}
    </div>
  );
}

function Page() {
  const { page } = useCore();
  const own = page.use(() => page.css);
  return (
    <>
      <style>{`${UI_CSS}\n${css}\n${own}`}</style>
      <div className={page.wide ? "sb-app wide" : "sb-app"}>
        <Column />
        <main className="sb-main">
          <Bar />
          <Ribbon />
          <Off />
          <Top />
          <div className="sb-view">
            <Screens />
          </div>
          <Toast />
          <Tabs />
        </main>
        <Search />
      </div>
    </>
  );
}

export function Shell({ core, pass }: { core: Core; pass: Pass }) {
  return (
    <CoreCtx.Provider value={{ ...core, pass }}>
      <Page />
    </CoreCtx.Provider>
  );
}
