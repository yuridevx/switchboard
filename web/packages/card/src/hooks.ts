// Стор модуля в экранах и общие выборки из roster.
import { useState } from "react";
import type { SessionRecord } from "@switchboard/web-core";
import { sessionOf, useApp, useModule } from "@switchboard/web-ui";
import { NAMES, type Can } from "./session.ts";
import type { CardStore } from "./store.ts";

export const useCard = (): CardStore => useModule<CardStore>();

/** Что умеет машина — по contract из roster; кнопка перерисуется, когда он изменился. */
export function useCan(machine: string): Can {
  const app = useApp();
  const on = app.use(() => NAMES.filter((n) => app.can(machine, n) === true));
  return (name) => on.includes(name);
}

/** Запись сессии из roster. */
export function useSession(callsign: string): SessionRecord | undefined {
  const app = useApp();
  return app.use(() => sessionOf(app, callsign));
}

/**
 * Действия над сессией: запрос, что идёт сейчас и отказ. Один путь на узкий и широкий вид; показывает отказ тот, кто нажал.
 * act возвращает слово отказа, успех — пусто.
 */
export function useSessionActions(callsign: string) {
  const app = useApp();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function act(name: string, body: Record<string, unknown> = {}): Promise<string> {
    setBusy(name);
    setError("");
    const r = await app.request(name, { callsign, ...body });
    setBusy("");
    if (!r.ok) setError(`${name}: ${r.error}`);
    return r.ok ? "" : r.error;
  }
  return { busy, error, act };
}
