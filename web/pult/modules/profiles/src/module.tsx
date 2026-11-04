// Снесено: экран на месте, данных нет.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./profiles.css";

export function createProfiles(_app: App): AppModule {
  return { screens: { profiles: { nav: "Профили", group: "Флот", label: "Профили", path: "profiles", view: () => <div>снесено</div>, head: () => ({ title: "Профили" }) } }, css };
}
