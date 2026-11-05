// Настройки модуля в prefs: цикл правки — у records, здесь — входы страницы и отказ словом в тосте.
import { settings } from "@switchboard/records";
import type { App, ConnState } from "./app.ts";

export type Scope = "user" | "global" | "app";

export type Personal = {
  /** первый ответ prefs получен: первый рисунок ждёт его; отказ — тоже ответ */
  ready(): boolean;
  get<T>(section: string): T | undefined;
  /** правка раздела: на экране сразу, в prefs — циклом; отказ — словом */
  edit<T>(section: string, fn: (old: T | undefined) => T): void;
  /** on.link: связь открылась — прочитать свои ключи; возврат одной машины настройки не трогает. Промис — чтение пошло. */
  onLink(state: ConnState, machine?: string): Promise<void> | undefined;
  /** остановка модуля: дождаться цикла записи */
  stop(): Promise<void>;
};

const AREA = { user: () => undefined, global: () => "global", app: (app: string | undefined) => `app:${app}` };

export function personal(app: Pick<App, "application" | "read" | "request" | "toast">, prefix: string, changed: () => void, scope: Scope = "user"): Personal {
  const s = settings({ read: app.read, ask: app.request, prefix, scope: AREA[scope](app.application), changed });
  return {
    ready: s.ready,
    get: s.get,
    edit(section, fn) {
      void s.edit(section, fn).then((word) => {
        if (word) app.toast(`Настройка не сохранилась: ${word}`, "bad");
      });
    },
    onLink: (state, machine) => (state === "open" && !machine ? s.read().then(() => {}) : undefined),
    stop: s.settled,
  };
}
