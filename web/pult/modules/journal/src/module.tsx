// Заглушка сноса: экран говорит «снесено».
import type { App } from "@switchboard/web-ui";
import type { AppModule } from "@switchboard/web-core";

export function createJournal(_app: App): AppModule {
  return { screens: { journal: { nav: "Журнал", group: "Флот", view: () => <p>снесено</p> } } };
}
