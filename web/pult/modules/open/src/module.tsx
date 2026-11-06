// pult-open — новая сессия: экран и настройка последних мест у почты.
import { personal, type App } from "@switchboard/web-ui";
import type { AppModule } from "@switchboard/web-core";
import { PARTY_CSS } from "@switchboard/web-party";
import open from "./open.css";
import { OpenScreen } from "./screen.tsx";

export type OpenState = ReturnType<typeof createOpenState>;

function createOpenState(app: App) {
  return personal(app, "pult-open", app.changed);
}

export function createOpen(app: App): AppModule {
  const recent = createOpenState(app);
  return {
    state: recent,
    on: { link: (state, machine) => void recent.onLink(state, machine) },
    screens: { open: { label: "Новая сессия", view: OpenScreen, head: () => ({ title: "Новая сессия" }) } },
    css: `${open}\n${PARTY_CSS}`,
    stop: recent.stop,
  };
}
