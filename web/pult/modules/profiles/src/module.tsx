// pult-profiles — профили всех машин одной таблицей. Своих данных нет: ответы машин живут, пока страница открыта.
import type { App, AppModule } from "@switchboard/web-core";
import { machineAnswers, machinesWith, type ProfilesAnswer } from "@switchboard/web-ui";
import type {} from "@switchboard/web-card";
import type {} from "@switchboard/web-labels";
import css from "./profiles.css";
import { ProfilesScreen } from "./ProfilesScreen.tsx";

export function createProfiles(app: App): AppModule {
  const answers = machineAnswers<ProfilesAnswer>(app, (machine) => app.read<ProfilesAnswer>("machine.profiles", { machine }), () => machinesWith(app, "machine.profiles"));
  return {
    state: answers,
    on: { link: answers.onLink },
    screens: { profiles: { nav: "Профили", group: "Флот", label: "Профили", view: ProfilesScreen, head: () => ({ title: "Профили" }) } },
    css,
  };
}
