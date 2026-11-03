// pult-profiles — профили флота, единственный экран профилей. Здесь — только связка с ядром; состояние — store.ts, вид — компоненты.
import type { AppModule } from "@switchboard/web-core";
import type {} from "@switchboard/web-labels";
import { ProfilesCtx } from "./context.ts";
import css from "./profiles.css";
import { ProfilesScreen } from "./ProfilesScreen.tsx";
import { createProfilesStore } from "./store.ts";

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createProfiles(): AppModule {
  const profiles = createProfilesStore();
  return {
    on: { roster: profiles.onRoster, link: profiles.onLink },
    screens: {
      profiles: {
        nav: "Профили",
        group: "Флот",
        label: "Профили",
        path: "profiles",
        view: () => (
          <ProfilesCtx.Provider value={profiles}>
            <ProfilesScreen />
          </ProfilesCtx.Provider>
        ),
        head: () => ({ title: "Профили" }),
      },
    },
    css,
    start: profiles.start,
  };
}
