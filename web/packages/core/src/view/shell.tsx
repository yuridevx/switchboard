// Страница: остов разметки; всё, что на ней, читает состояние страницы выборкой.
import type { Core } from "../app.ts";
import type { Pass } from "../pass.ts";
import { Bar, Off } from "./bar.tsx";
import { Column, GroupRow, Tabs } from "./nav.tsx";
import { Boundary, CoreCtx, Place, useCore } from "./place.tsx";
import { Search } from "./search.tsx";
import { Stops } from "./stops.tsx";

const SCREEN = { display: "flex", flexDirection: "column", minHeight: 0, flex: 1 } as const;

function Screens() {
  const { page, route } = useCore();
  const cur = page.use(() => (page.stop ? null : page.current));
  if (!cur) return <Stops />;
  const screen = (
    <div className="sb-screen" data-screen={cur.screen} style={SCREEN}>
      <Place key={route.addressOf(cur.screen, cur.params) + cur.screen} screen={cur.screen} params={cur.params} />
    </div>
  );
  if (!cur.master) return screen;
  return (
    <div className="sb-split">
      <div className="sb-master" data-screen={cur.master}>
        <Place key={cur.master} screen={cur.master} />
      </div>
      <div className="sb-detail">{screen}</div>
    </div>
  );
}

/** Полоса над разделом и над списком рядом. */
function Top() {
  const { page, mods } = useCore();
  const v = page.use(() => {
    const s = page.current && mods.screens.get(page.current.screen);
    return { on: !page.stop && !!s, shown: !!s?.def.nav || !!page.current?.master };
  });
  return (
    <div className="sb-top" hidden={!v.shown || !v.on}>
      {v.on &&
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

function Page({ css }: { css: string }) {
  const { page } = useCore();
  const own = page.use(() => page.css);
  return (
    <>
      <style>{css + own}</style>
      <div className={page.wide ? "sb-app wide" : "sb-app"}>
        <Column />
        <main className="sb-main">
          <Bar />
          <GroupRow />
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

export function Shell({ core, pass, css, fatal }: { core: Core; pass: Pass; css: string; fatal(e: unknown): void }) {
  return (
    <CoreCtx.Provider value={{ ...core, pass }}>
      <Boundary onError={fatal}>
        <Page css={css} />
      </Boundary>
    </CoreCtx.Provider>
  );
}
