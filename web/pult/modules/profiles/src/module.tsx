// pult-profiles — просмотр профилей: что внутри кусочков и что получит сессия. Своих данных нет.
import { Layers } from "lucide-react";
import type { AppModule } from "@switchboard/web-core";
import css from "./profiles.css";
import { ProfilesScreen, type ProfilesSeen } from "./ProfilesScreen.tsx";

export function createProfiles(): AppModule {
  return {
    state: { seen: { picked: null } } satisfies ProfilesSeen,
    screens: { profiles: { nav: "Профили", icon: Layers, group: "Флот", label: "Профили", view: ProfilesScreen, head: () => ({ title: "Профили" }) } },
    css,
  };
}
