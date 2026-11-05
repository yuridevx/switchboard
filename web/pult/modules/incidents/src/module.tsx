// Заглушка сноса: экран говорит «снесено».
import type { App } from "@switchboard/web-ui";
import type { AppModule } from "@switchboard/web-core";

export function createIncidents(_app: App): AppModule {
  return {
    screens: { incidents: { nav: "Инциденты", narrowGroup: "Флот", mark: "incidents.open", view: () => <p>снесено</p> } },
    marks: { "incidents.open": () => 0 },
  };
}
