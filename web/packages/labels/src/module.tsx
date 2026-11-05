// Заглушка сноса.
import type { AppModule } from "@switchboard/web-core";
import type { App } from "@switchboard/web-ui";

export const createLabels = (_app: App): AppModule => {
  throw new Error("снесено");
};
