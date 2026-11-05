// pult-settings — настройки флота: вкладки «Выпуски», «Пропуска», «GitHub и устройство»; на телефоне — только устройство.
import type { ScreenProps } from "@switchboard/web-core";
import { Page, PageHead, Tabs, useApp, useModule, type App } from "@switchboard/web-ui";
import type { AppModule } from "@switchboard/web-core";
import { Device, GitHub } from "./general.tsx";
import { Passes } from "./passes.tsx";
import { ReleasesTab } from "./releases.tsx";
import css from "./settings.css";
import { createSettingsState, type SettingsState } from "./state.ts";

const TABS = [["releases", "Выпуски"], ["passes", "Пропуска"], ["general", "GitHub и устройство"]] as const;
type Tab = (typeof TABS)[number][0];

function SettingsScreen({ params }: ScreenProps) {
  const app = useApp();
  useModule<SettingsState>();
  if (!app.wide) {
    return (
      <Page>
        <Device />
      </Page>
    );
  }
  const tab: Tab = TABS.some(([k]) => k === params.tab) ? (params.tab as Tab) : "releases";
  return (
    <Page>
      <PageHead title="Настройки">
        <Tabs className="st-tabs" tabs={TABS} cur={tab} pick={(k) => app.open("settings", { tab: k })} />
      </PageHead>
      {tab === "releases" ? <ReleasesTab machine={params.machine} /> : null}
      {tab === "passes" ? <Passes /> : null}
      {tab === "general" ? (
        <>
          <GitHub />
          <Device />
        </>
      ) : null}
    </Page>
  );
}

export function createSettings(app: App): AppModule {
  const st = createSettingsState(app);
  return {
    state: st,
    on: { link: st.keeper.onLink },
    screens: {
      settings: {
        nav: "Настройки",
        group: "Флот",
        label: "Настройки",
        view: SettingsScreen,
        head: () => ({ title: "Настройки" }),
        find: (q) => (app.wide ? TABS.filter(([, name]) => q && name.toLowerCase().includes(q)).map(([tab, name]) => ({ label: `Настройки: ${name.toLowerCase()}`, screen: "settings", params: { tab } })) : []),
      },
    },
    commands: {
      "keeper.open": { run: st.openKeeper },
      "keeper.close": { run: st.closeKeeper },
      "keeper.reload": { run: (p) => void st.keeper.reload(p.machine) },
    },
    marks: { "keeper.answers": () => st.keeper },
    css,
    start() {
      // GitHub вернул код нового приложения: экран — настройки на своей вкладке
      const code = new URLSearchParams(location.search).get("code");
      if (!code) return;
      st.setCode(code);
      if (!location.hash) history.replaceState(null, "", `${location.pathname}${location.search}#settings?tab=general`);
    },
  };
}
