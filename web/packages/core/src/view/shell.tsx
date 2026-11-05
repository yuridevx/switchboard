// Вид ядра: рисует состояние страницы и зовёт её действия. Сам ничего не решает.
import type { CSSProperties } from "react";
import { UI_CSS } from "@switchboard/web-ui";
import type { Bus, Core } from "../core.ts";
import type { Modules } from "../modules.ts";
import { Bar, Off } from "./bar.tsx";
import { Column, Ribbon, Tabs } from "./nav.tsx";
import { Place } from "./place.tsx";
import { Search } from "./search.tsx";
import css from "./shell.css";
import { Connecting, stopScreen } from "./stops.tsx";

/** Что вид знает о странице. */
export type Page = {
  core: Core;
  bus: Bus;
  modules: Modules;
  wide: boolean;
  brand?: string;
  doc: Document;
  open(screen: string, params?: Record<string, string>): void;
  back(): void;
  reload(): void;
  /** «Сейчас» на полосе: новое соединение без паузы */
  now(): void;
  /** открыть или закрыть поиск */
  search(): void;
  wipe(): Promise<void>;
  /** приглашение → пропуск; отказ — слово */
  accept(invite: string): Promise<string | null>;
};

const FILL: CSSProperties = { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 };

/** Стили страницы: основание и вид ядра — без области, стили модулей — в месте модуля до вложенного модуля. */
const pageCss = ({ entries }: Modules) => [`${UI_CSS}\n${css}`, ...entries.flatMap((e) => (e.def.css ? [`@scope ([data-module="${e.name}"]) to ([data-module]) {\n${e.def.css}\n}`] : []))].join("\n");

function Screen({ page, name, master }: { page: Page; name: string; master?: boolean }) {
  const { modules, core } = page;
  const [entry, screen] = modules.screenOf(name)!;
  const params = page.bus.use(() => (master ? NONE : (core.current?.params ?? NONE)));
  return <Place entry={entry} name={name} screen={screen} params={params} modules={modules} />;
}
const NONE = {};

function View({ page }: { page: Page }) {
  const { core, bus } = page;
  const stopped = bus.use(() => core.stopped);
  const name = bus.use(() => core.current?.screen);
  const master = bus.use(() => core.current?.master ?? null);
  const body = stopped !== null ? (
    <div className="sb-full">{stopScreen(page, stopped)}</div>
  ) : !name ? (
    <div className="sb-full">
      <Connecting page={page} />
    </div>
  ) : master ? (
    <div className="sb-split">
      <div className="sb-master" data-screen={master}>
        <Screen page={page} name={master} master />
      </div>
      <div className="sb-detail">
        <div className="sb-screen" data-screen={name} style={FILL}>
          <Screen page={page} name={name} />
        </div>
      </div>
    </div>
  ) : (
    <div className="sb-screen" data-screen={name} style={FILL}>
      <Screen page={page} name={name} />
    </div>
  );
  return <div className="sb-view">{body}</div>;
}

/** Полоса над экранами разделов и над списком рядом; модули в ней живут и скрытые. */
function Top({ page }: { page: Page }) {
  const { core, bus, modules } = page;
  const started = bus.use(() => core.started);
  const shown = bus.use(() => {
    const c = core.current;
    return !!c && core.stopped === null && (!!c.master || !!modules.screenOf(c.screen)?.[1].nav);
  });
  const tops = modules.entries.flatMap((e) => Object.entries(e.def.screens ?? {}).flatMap(([name, s]) => (s.place === "top" ? [{ e, name, s }] : [])));
  return (
    <div className="sb-top" hidden={!shown}>
      {started &&
        tops.map(({ e, name, s }) => (
          <div key={name}>
            <Place entry={e} name={name} screen={s} params={NONE} modules={modules} />
          </div>
        ))}
    </div>
  );
}

function Toast({ page }: { page: Page }) {
  const toast = page.bus.use(() => page.core.toast);
  return (
    <div className={`sb-toast ${toast?.tone ?? ""}`} role="alert" hidden={!toast?.shown}>
      {toast?.text}
    </div>
  );
}

export function Shell({ page }: { page: Page }) {
  return (
    <>
      <style>{pageCss(page.modules)}</style>
      <div className={page.wide ? "sb-app wide" : "sb-app"}>
        <Column page={page} />
        <main className="sb-main">
          <Bar page={page} />
          <Ribbon page={page} />
          <Off page={page} />
          <Top page={page} />
          <View page={page} />
          <Toast page={page} />
          <Tabs page={page} />
        </main>
        <Search page={page} />
      </div>
    </>
  );
}
