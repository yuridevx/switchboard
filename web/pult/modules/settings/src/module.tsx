// Настройки флота: вкладки «Выпуски», «Пропуска», «GitHub и устройство»; на телефоне — только устройство.
import { Settings } from "lucide-react";
import type { AppPart, ScreenProps } from "@switchboard/web-core";
import { useEffect } from "react";
import { Page, PageHead, Tabs, useApp, useModule } from "@switchboard/web-ui";
import { GeneralTab, githubCode } from "./general.tsx";
import { PassesTab } from "./passes.tsx";
import { ReleasesTab } from "./releases.tsx";
import { createState, type SettingsState } from "./state.ts";
import css from "./settings.css";

const TABS = [["releases", "Выпуски"], ["passes", "Пропуска"], ["general", "GitHub и устройство"]] as const;
type Tab = (typeof TABS)[number][0];

function SettingsScreen({ params }: ScreenProps) {
  const app = useApp();
  const state = useModule<SettingsState>();
  const asked = TABS.some(([k]) => k === params.tab) ? (params.tab as Tab) : undefined;
  useEffect(() => {
    if (asked) state.local.set((l) => void (l.tab = asked));
  }, [asked, state]);
  if (!app.wide) {
    return (
      <Page>
        <GeneralTab />
      </Page>
    );
  }
  const tab = asked ?? (state.local.get().tab as Tab);
  return (
    <Page>
      <PageHead title="Настройки">
        <Tabs className="st-tabs" tabs={TABS} cur={tab} pick={(k) => app.open("settings", { tab: k })} />
      </PageHead>
      {tab === "releases" && <ReleasesTab machine={params.machine} />}
      {tab === "passes" && <PassesTab />}
      {tab === "general" && <GeneralTab />}
    </Page>
  );
}

export const createSettings = ((app) => {
  const state = createState(app);
  return {
    css,
    state,
    on: {
      link(s, machine) {
        state.answers.onLink(s, machine);
        state.repos.onLink(s, machine);
        return state.fleet.onLink(s, machine);
      },
    },
    stop: state.fleet.stop,
    // GitHub вернул человека на корень страницы: экран знает свой адрес сам
    start() {
      if (githubCode() && !location.hash) history.replaceState(null, "", `${location.pathname}${location.search}#settings?tab=general`);
    },
    screens: {
      settings: {
        nav: "Настройки", icon: Settings,
        group: "Флот",
        label: "Настройки",
        view: SettingsScreen,
        head: () => ({ title: "Настройки" }),
        find: (q) => TABS.flatMap(([tab, name]) => (name.toLowerCase().includes(q) ? [{ label: `Настройки: ${name.toLowerCase()}`, hint: "Флот", screen: "settings", params: { tab } }] : [])),
      },
    },
    marks: { "keeper.answers": () => state.answers.get() },
    commands: {
      "keeper.open": { run: state.open },
      "keeper.close": { run: state.close },
      "keeper.reload": { run: (p) => void state.answers.reload(p.machine) },
    },
  };
}) satisfies AppPart["module"];
