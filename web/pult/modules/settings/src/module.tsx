// pult-settings — настройки флота вкладками: выпуски по машинам и каталог, пропуска, GitHub и устройство. Здесь — только связка с ядром.
import type { AppModule, ScreenProps } from "@switchboard/web-core";
import { SettingsCtx } from "./context.ts";
import css from "./settings.css";
import { SettingsScreen } from "./SettingsScreen.tsx";
import { createSettingsStore } from "./store.ts";

const TABS = [
  ["releases", "Выпуски"],
  ["passes", "Пропуска"],
  ["general", "GitHub и устройство"],
];

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createSettings(): AppModule {
  const settings = createSettingsStore();
  return {
    on: { roster: settings.onRoster },
    screens: {
      settings: {
        nav: "Настройки",
        group: "Флот",
        label: "Настройки",
        view: (p: ScreenProps) => (
          <SettingsCtx.Provider value={settings}>
            <SettingsScreen {...p} />
          </SettingsCtx.Provider>
        ),
        head: () => ({ title: "Настройки" }),
        find: (q: string) =>
          TABS.filter(([, l]) => !q || l.toLowerCase().includes(q)).map(([tab, l]) => ({ label: `Настройки: ${l.toLowerCase()}`, hint: "Флот", screen: "settings", params: { tab } })),
      },
    },
    css,
    start: settings.start,
  };
}
