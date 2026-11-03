// Запись сессии из roster: подписи и разбор полей. Чистые функции; общие для узкого и широкого вида и шапки экрана.
import type { Result, SessionRecord } from "@switchboard/web-core";
import type {} from "@switchboard/web-labels";

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

export const slotOf = (s?: SessionRecord) => s?.slot as { name?: string; wait?: number | null } | null | undefined;
