// Настройки в модуле страницы: цикл над Worker'ом prefs из библиотеки records. Ключи — «префикс.раздел». Область: человек (по умолчанию), весь флот или это приложение.
// Отказ записи — словом на экране. Цикл один на модуль и область; остановка модуля ждёт его. Модуль объявляет prefs.get и prefs.set в uses.
import { settings } from "@switchboard/records";
import type { App, ConnState } from "./app.ts";

/** Что цикл настроек берёт у app модуля. */
type AppLike = Pick<App, "application" | "read" | "request" | "toast">;

export type Scope = "user" | "global" | "app";

export type Personal = {
  /** первый ответ prefs получен: первый рисунок ждёт его; отказ — тоже ответ */
  ready(): boolean;
  /** значение раздела сейчас */
  get<T>(section: string): T | undefined;
  /** правка раздела: на экране сразу, в prefs — циклом; отказ — словом */
  edit<T>(section: string, fn: (old: T | undefined) => T): void;
  /** on.link: связь открылась — прочитать свои ключи; возврат одной машины настройки не трогает. Промис — чтение пошло. */
  onLink(state: ConnState, machine?: string): Promise<void> | undefined;
  /** остановка модуля: дождаться цикла записи */
  stop(): Promise<void>;
};

export function personal(app: AppLike, prefix: string, changed: () => void, scope: Scope = "user"): Personal {
  const s = settings({
    ask: <T,>(name: string, body: Record<string, unknown>) => app.request<T>(name, body),
    read: <T,>(name: string, body: Record<string, unknown>) => app.read<T>(name, body),
    prefix,
    scope: scope === "user" ? undefined : scope === "global" ? "global" : `app:${app.application ?? ""}`,
    changed,
  });
  return {
    ready: s.ready,
    get: s.get,
    edit: (section, fn) => {
      void s.edit(section, fn).then((word) => {
        if (word) app.toast(`Настройка не сохранилась: ${word}`, "bad");
      });
    },
    onLink: (state, machine) => (state === "open" && !machine ? s.read().then(() => {}) : undefined),
    stop: s.settled,
  };
}
