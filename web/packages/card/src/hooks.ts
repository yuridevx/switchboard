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
 * Действия над сессией — один путь на узкий и широкий вид. Все возвращают слово отказа, успех — пусто.
 * send — только запрос; act — ещё что идёт сейчас и отказ на месте кнопки; update и start — отказ тостом.
 */
export function useSessionActions(callsign: string) {
  const app = useApp();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function send(name: string, body: Record<string, unknown> = {}): Promise<string> {
    const r = await app.request(name, { callsign, ...body });
    return r.ok ? "" : r.error;
  }
  async function act(name: string, body: Record<string, unknown> = {}): Promise<string> {
    setBusy(name);
    setError("");
    const word = await send(name, body);
    setBusy("");
    if (word) setError(`${name}: ${word}`);
    return word;
  }
  async function update(body: Record<string, unknown>, what: string) {
    const word = await send("session.update", body);
    if (word) app.toast(`${callsign}: ${what} — ${word}`);
  }
  async function start() {
    const word = await act("session.start");
    if (word) app.toast(`${callsign}: «Запустить» — ${word}`);
  }
  return { busy, error, send, act, update, start };
}
