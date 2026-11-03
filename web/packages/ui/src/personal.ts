// Настройки в модуле страницы: цикл над Worker'ом prefs из библиотеки records. Ключи — «префикс.раздел». Область: человек (по умолчанию), весь флот или это приложение.
// Отказ записи — словом на экране. Цикл один на модуль и область; остановка модуля ждёт его. Модуль объявляет prefs.get и prefs.set в uses.
import { settings } from "@switchboard/records";

/** Что цикл настроек берёт у app модуля. */
type AppLike = {
  /** имя приложения из списка сборки: pult, phone */
  readonly application?: string;
  request<T = unknown>(name: string, body?: Record<string, unknown>): Promise<{ ok: true; result: T } | { ok: false; error: string }>;
  toast(text: string, tone?: "ok" | "bad"): void;
};

export type Scope = "user" | "global" | "app";

export type Personal = {
  /** первый ответ prefs получен: первый рисунок ждёт его; отказ — тоже ответ */
  ready(): boolean;
  /** значение раздела сейчас */
  get<T>(section: string): T | undefined;
  /** правка раздела: на экране сразу, в prefs — циклом; отказ — словом */
  edit<T>(section: string, fn: (old: T | undefined) => T): void;
  /** прочитать все ключи области: связь открылась */
  read(): Promise<void>;
  /** дождаться цикла записи: остановка модуля */
  settled(): Promise<void>;
};

export function personal(app: AppLike, prefix: string, changed: () => void, scope: Scope = "user"): Personal {
  const s = settings({
    ask: <T,>(name: string, body: Record<string, unknown>) => app.request<T>(name, body),
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
    read: async () => {
      await s.read();
    },
    settled: s.settled,
  };
}
