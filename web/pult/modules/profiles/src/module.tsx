// pult-profiles — профили флота, единственный экран профилей. Здесь — только связка с ядром; состояние — store.ts, вид — компоненты.
import type { App, AppModule } from "@switchboard/web-core";
import type {} from "@switchboard/web-labels";
import css from "./profiles.css";
import { ProfilesScreen } from "./ProfilesScreen.tsx";
import { createProfilesStore } from "./store.ts";

/** Функция модуля: ядро зовёт её один раз со своим app; память — на этот запуск. */
export function createProfiles(app: App): AppModule {
  const profiles = createProfilesStore(app);
  return {
    state: profiles,
    on: { link: profiles.onLink },
    screens: {
      profiles: {
        nav: "Профили",
        group: "Флот",
        label: "Профили",
        path: "profiles",
        view: ProfilesScreen,
        head: () => ({ title: "Профили" }),
      },
    },
    css,
  };
}
