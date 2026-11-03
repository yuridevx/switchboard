// Стенд чата для тестов: настоящие модули на поддельном relay; чат открыт по адресу.
import { createAlerts, manifest as alertsM } from "@switchboard/web-alerts";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import type { Roster } from "@switchboard/web-core";
import { createChat, manifest as chatM } from "../contract.ts";
import { FakeRelay, flush, homeRoster, stand, type StandOptions } from "../../core/stand/app.ts";

export const parts = () => [
  { manifest: boardM, module: createBoard() },
  { manifest: cardM, module: createCard() },
  { manifest: chatM, module: createChat() },
  { manifest: askM, module: createAsk() },
  { manifest: alertsM, module: createAlerts({}) },
];

/** Флот home, у машин — session.call и session.files. */
export function roster(tweak: (r: Roster) => void = () => {}): Roster {
  const r = homeRoster();
  for (const m of r.machines) m.contract = { ...m.contract, "session.call": 1, "session.files": 1 };
  tweak(r);
  return r;
}

export function relayFor(r = roster(), messages: unknown[] = []) {
  const relay = new FakeRelay(r);
  relay.handlers["session.watch"] = () => ({ ok: true });
  relay.handlers["session.unwatch"] = () => ({ ok: true });
  relay.handlers["session.history"] = () => ({ ok: true, result: { messages, more: false } });
  relay.handlers["question.list"] = () => ({ ok: true, result: [] });
  relay.handlers["session.prompt"] = (f) => ({ ok: true, result: { uuid: f.uuid } });
  return relay;
}

/** Открыть чат сессии: узко — на весь экран, широко — справа от списка. */
export async function chat(callsign: string, o: { relay?: FakeRelay; wide?: boolean; store?: StandOptions["store"] } = {}) {
  const relay = o.relay ?? relayFor();
  const t = await stand(parts(), { relay, wide: o.wide, store: o.store, options: o.wide ? { beside: { card: "board", chat: "board", ask: "board" } } : {} });
  history.pushState(null, "", `/#chat?callsign=${encodeURIComponent(callsign)}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await flush();
  const type = async (text: string) => {
    const inp = t.$<HTMLTextAreaElement>(".chat-inp")!;
    inp.value = text;
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  };
  const key = async (key: string, init: KeyboardEventInit = {}) => {
    t.$(".chat-inp")!.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...init }));
    await flush();
  };
  const btn = (scope: string, text: string) => [...(t.$(scope) ?? t.root).querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text) ?? null;
  const pick = async (...files: File[]) => {
    const el = t.$<HTMLInputElement>('.chat input[type="file"]')!;
    Object.defineProperty(el, "files", { configurable: true, value: files });
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await flush(10);
  };
  const events = async (from: string, events: unknown[], seq?: number) => {
    relay.push({ type: "session.events", from, seq, events });
    await flush();
  };
  return { ...t, relay, type, key, btn, pick, events };
}

export const user = (uuid: string, text: string) => ({ type: "user", uuid, message: { content: text } });
export const asst = (uuid: string, content: unknown[]) => ({ type: "assistant", uuid, message: { content } });
