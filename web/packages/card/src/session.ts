// Запись сессии из roster: подписи и разбор полей. Чистые функции; общие для узкого и широкого вида и шапки экрана.
import type { App, Result, SessionRecord } from "@switchboard/web-core";
import type {} from "@switchboard/web-labels";
import { hhmm } from "@switchboard/web-ui";

/** Подпись и лампа состояния (подсказка индикатора). */
export const LABEL: Record<string, [string, string]> = {
  busy: ["работает", "busy"],
  waiting: ["ждёт вас", "wait"],
  failed: ["не запустилась", "bad"],
  idle: ["свободна", "idle"],
  starting: ["запускается", "busy"],
  stopping: ["останавливается", "stop"],
  stopped: ["остановлена", "stop"],
};
export const LIVE = new Set(["idle", "busy", "waiting"]);

/** Запросы, от которых зависят кнопки карточки. */
export const NAMES = ["session.stop", "session.start", "session.update", "session.spec", "session.call", "session.remove", "session.slot", "session.profile", "machine.slots", "machine.profiles", "machine.accounts", "machine.journal"] as const;
export type Name = (typeof NAMES)[number];
export type Can = (name: Name) => boolean;

/** Что показывать в шапке — выбор устройства; переключатели — экран card.view в панели вида «Работы». */
export const HEAD0 = { haddr: false, howner: true, hprof: true, hmodel: true };
export type HeadView = typeof HEAD0;

export type Win = { utilization: number; resetsAt?: number };
export type Acc = { email?: string; plan?: string; limits?: Record<string, Win> };
export type SlotInfo = { account: string | null; order?: string[] };
export type Mcp = { name: string; status?: string };
export type Model = { value: string; displayName?: string };

/** Машина такого запроса не умеет: не спрашиваем, данных нет. */
export const notAsked = <T,>(): Promise<Result<T>> => Promise.resolve({ ok: false, error: "" });

/** Время сброса: секунды или миллисекунды эпохи → ЧЧ:ММ. */
export const at = (t: number) => hhmm(t < 1e12 ? t * 1000 : t);
export const slotOf = (s?: SessionRecord) => s?.slot as { name?: string; wait?: number | null } | null | undefined;
export const profileOf = (s?: SessionRecord) => (s?.profile as { id?: string } | null | undefined)?.id;
export const remoteOf = (s?: SessionRecord) => (s?.remote as { url?: string } | undefined)?.url;
export const failedText = (s: SessionRecord) => (s.failed ? Object.entries(s.failed as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join("; ") : "");

export const sessionName = (app: App, callsign: string) => app.mark("label.session", callsign) ?? { text: callsign, human: false };
export const machineName = (app: App, machine: string) => app.mark("label.machine", machine) ?? { text: `@${machine}`, human: false };
