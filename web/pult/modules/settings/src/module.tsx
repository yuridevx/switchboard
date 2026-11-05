// pult-settings — настройки флота вкладками: выпуски по машинам и каталог, пропуска, GitHub и устройство. Здесь — только связка с ядром.
import type { App, AppModule, ScreenProps } from "@switchboard/web-core";
import { Page, PageHead, Tabs, useApp } from "@switchboard/web-ui";
import { Device, Github } from "./general.tsx";
import { Passes } from "./passes.tsx";
import { Releases } from "./releases.tsx";
import css from "./settings.css";
import { createSettingsState } from "./state.ts";

type Tab = "releases" | "passes" | "general";

const TABS = [
  ["releases", "Выпуски"],
  ["passes", "Пропуска"],
  ["general", "GitHub и устройство"],
] as const;

/** Экран настроек: заголовок с вкладками и содержимое вкладки. Новые параметры адреса — экран начат заново. */
function SettingsScreen({ params }: ScreenProps) {
  const app = useApp();
  const tab: Tab = !app.wide ? "general" : params.tab === "passes" || params.tab === "general" ? params.tab : "releases";
  return (
    <Page>
      {app.wide ? (
        <PageHead title="Настройки">
          <Tabs className="st-tabs" tabs={TABS} cur={tab} pick={(k) => app.open("settings", { tab: k })} />
        </PageHead>
      ) : null}
      {tab === "releases" ? (
        <Releases machine={params.machine} />
      ) : tab === "passes" ? (
        <Passes />
      ) : (
        <>
          {app.wide ? <Github /> : null}
          <Device />
        </>
      )}
    </Page>
  );
}

/** Функция модуля: ядро зовёт её один раз со своим app; память — на этот запуск. */
export function createSettings(app: App): AppModule {
  const settings = createSettingsState(app);
  return {
    state: settings,
    start: settings.start,
    on: { link: settings.onLink },
    commands: {
      "keeper.open": { run: settings.openKeeper },
      "keeper.close": { run: settings.closeKeeper },
      "keeper.reload": { run: (p) => void settings.reloadKeeper(p.machine ?? "") },
    },
    screens: {
      settings: {
        nav: "Настройки",
        group: "Флот",
        label: "Настройки",
        view: SettingsScreen,
        head: () => ({ title: "Настройки" }),
        find: (q: string) => TABS.filter(([, l]) => !q || l.toLowerCase().includes(q)).map(([tab, l]) => ({ label: `Настройки: ${l.toLowerCase()}`, hint: "Флот", screen: "settings", params: { tab } })),
      },
    },
    marks: { "keeper.answers": settings.keeperAnswers },
    css,
  };
}
