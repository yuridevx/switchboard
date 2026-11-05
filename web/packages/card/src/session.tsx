// Сессия карточки: что умеет её машина, запись из roster, действия одним путём на узкий и широкий вид, окно «Имена».
import { useState } from "react";
import type { SessionRecord } from "@switchboard/web-core";
import { sessionOf, useApp } from "@switchboard/web-ui";
import type {} from "@switchboard/web-labels";

/** Запросы, от которых зависят кнопки карточки. */
const NAMES = ["session.stop", "session.start", "session.update", "session.spec", "session.call", "session.remove", "session.slot", "session.profile", "machine.profiles", "machine.accounts", "machine.journal"] as const;
export type Can = (name: (typeof NAMES)[number]) => boolean;

/** Сессия не идёт: её можно запустить, но не остановить. */
export const isDown = (s?: SessionRecord) => s?.state === "stopped" || s?.state === "failed";

/** Вкладка при рисовании: выбранная, пока она есть; пропала или такой нет — запасная. */
export const tabIn = (picked: string, tabs: Array<[string, string]>, fallback: string) => (tabs.some(([k]) => k === picked) ? picked : fallback);

/** Что умеет машина — по contract из roster; кнопка перерисуется, когда он изменился. */
export function useCan(machine: string): Can {
  const app = useApp();
  const on = app.use(() => NAMES.filter((n) => app.can(machine, n) === true));
  return (name) => on.includes(name);
}

export function useSession(callsign: string): SessionRecord | undefined {
  const app = useApp();
  return app.use(() => sessionOf(app, callsign));
}

/** Действия над сессией. Возвращают слово отказа, успех — пусто. send — только запрос; act — ещё что идёт сейчас и отказ на месте кнопки; update и start — отказ тостом. */
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

/** Окно «Имена» web-labels поверх карточки. */
export function Names({ callsign, close }: { callsign: string; close(): void }) {
  const app = useApp();
  return (
    <div>
      <app.Slot screen="labels" params={{ callsign }} close={close} />
    </div>
  );
}
