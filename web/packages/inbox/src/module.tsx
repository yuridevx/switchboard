// Снесено: вход контракта отказывает словом.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./inbox.css";

export function createInbox(_app: App): AppModule {
  return {
    css,
    screens: { "inbox": { label: "снесено", view: () => <div>снесено</div> } },
    marks: { "you": () => { throw new Error("снесено"); } },
    commands: {  },
  };
}
