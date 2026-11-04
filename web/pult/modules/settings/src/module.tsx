// pult-settings — настройки флота вкладками: выпуски по машинам и каталог, пропуска, GitHub и устройство. Здесь — только связка с ядром.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./settings.css";
import { SettingsScreen } from "./SettingsScreen.tsx";
import { createSettingsStore } from "./store.ts";

const TABS = [
  ["releases", "Выпуски"],
  ["passes", "Пропуска"],
  ["general", "GitHub и устройство"],
];

/** Функция модуля: ядро зовёт её один раз со своим app; память — на этот запуск. */
export function createSettings(app: App): AppModule {
  const settings = createSettingsStore(app);
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
        find: (q: string) =>
          TABS.filter(([, l]) => !q || l.toLowerCase().includes(q)).map(([tab, l]) => ({ label: `Настройки: ${l.toLowerCase()}`, hint: "Флот", screen: "settings", params: { tab } })),
      },
    },
    marks: { "keeper.answers": settings.keeperAnswers },
    css,
  };
}
