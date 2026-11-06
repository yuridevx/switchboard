// Настройки модуля: цикл правки у records; здесь — область, связь и отказ словом.
import { settings } from "@switchboard/records";
import type { App, ConnState } from "./app.ts";

/** user — человек, global — весь флот, app — это приложение. */
export type Scope = "user" | "global" | "app";

export type Personal = ReturnType<typeof personal>;

export function personal(app: Pick<App, "application" | "read" | "request" | "toast">, prefix: string, changed: () => void, scope: Scope = "user") {
  const area = scope === "global" ? "global" : scope === "app" ? `app:${app.application}` : undefined;
  const s = settings({ read: app.read as never, ask: app.request as never, prefix, scope: area, changed });
  return {
    ready: s.ready,
    get: s.get,
    /** Правка видна сразу; отказ записи — тостом. */
    edit<T>(section: string, fn: (old: T | undefined) => T) {
      void s.edit(section, fn).then((word) => word && app.toast(`Настройка не сохранилась: ${word}`, "bad"));
    },
    /** Связь открылась: читать; вернулась одна машина — настройки не задеты. */
    onLink: (state: ConnState, machine?: string) => (state === "open" && !machine ? s.read() : undefined),
    stop: s.settled,
  };
}
