// Настройки в модуле страницы: цикл над Worker'ом prefs из библиотеки records. Ключи — «префикс.раздел». Область: человек (по умолчанию), весь флот или это приложение.
// Цикл один на модуль и область; остановка модуля ждёт его. Модуль объявляет prefs.get и prefs.set в uses.
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

/** Поле scope запроса: у человека его нет. */
function scopeWord(scope: Scope, application = ""): string | undefined {
  if (scope === "user") return undefined;
  return scope === "global" ? "global" : `app:${application}`;
}

export function personal(app: Pick<App, "application" | "read" | "request" | "toast">, prefix: string, changed: () => void, scope: Scope = "user"): Personal {
  const cycle = settings({
    ask: <T,>(name: string, body: Record<string, unknown>) => app.request<T>(name, body),
    read: <T,>(name: string, body: Record<string, unknown>) => app.read<T>(name, body),
    prefix,
    scope: scopeWord(scope, app.application),
    changed,
  });
  return {
    ready: cycle.ready,
    get: cycle.get,
    edit(section, fn) {
      void cycle.edit(section, fn).then((word) => {
        if (word) app.toast(`Настройка не сохранилась: ${word}`, "bad");
      });
    },
    onLink: (state, machine) => (state === "open" && !machine ? cycle.read().then(() => {}) : undefined),
    stop: cycle.settled,
  };
}
