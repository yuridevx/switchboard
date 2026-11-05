// Запись сессии и машины в roster: что читают разные экраны.
import type { SessionRecord } from "@switchboard/relay";
import { nameOf, userOf } from "@switchboard/protocol";
import type { App } from "./app.ts";
import { effortName } from "./labels.ts";
import { at } from "./time.ts";

type Marked = Pick<App, "mark">;
type Rostered = Pick<App, "roster">;
/** Подпись имени: человеческое имя или адрес. */
export type Shown = { text: string; human: boolean };

export const sessionOf = (app: Rostered, callsign: string): SessionRecord | undefined => app.roster()?.sessions.find((s) => s.callsign === callsign);

/** Подпись сессии без своего имени: имя из позывного. */
export const plainSession = (callsign: string): Shown => ({ text: nameOf(callsign), human: false });
/** Подпись машины без своего имени: адрес. */
export const plainMachine = (machine: string): Shown => ({ text: `@${machine}`, human: false });

/** Имя сессии; модуля имён нет или он упал — как без своего имени. */
export const sessionLabel = (app: Marked, callsign: string): Shown => (app.mark("label.session", callsign) as Shown | undefined) ?? plainSession(callsign);
export const machineLabel = (app: Marked, machine: string): Shown => (app.mark("label.machine", machine) as Shown | undefined) ?? plainMachine(machine);

export const slotOf = (s?: SessionRecord) => s?.slot as { name?: string; wait?: number | null } | null | undefined;
export const incidentOf = (s?: SessionRecord) => s?.incident as { type?: string; key?: string } | null | undefined;

/** Ссылка Remote Control сессии. */
export const remoteOf = (s?: SessionRecord): string | undefined => (typeof s?.remote === "string" ? s.remote : (s?.remote as { url?: string } | undefined)?.url);

/** Причина сбоя сессии: «часть: причина; …». */
export const failText = (s: SessionRecord): string =>
  Object.entries((s.failed ?? {}) as Record<string, unknown>)
    .map(([part, why]) => `${part}: ${String(why)}`)
    .join("; ");

/** Короткое имя профиля: team/profiles/ops → ops. */
export const profileName = (id: string): string => id.slice(id.lastIndexOf("/") + 1);
export const profileIdOf = (s?: SessionRecord): string | undefined => (s?.profile as { id?: string } | null | undefined)?.id;
export const profileNameOf = (s?: SessionRecord): string | undefined => {
  const id = profileIdOf(s);
  return id && profileName(id);
};

/** Машины на связи, у которых в contract есть все эти запросы; без запросов — все. */
export const machinesWith = (app: Rostered, ...names: string[]): string[] => (app.roster()?.machines ?? []).filter((m) => names.every((n) => Object.hasOwn(m.contract ?? {}, n))).map((m) => m.machine);

/** Мой адрес ~почта — из адреса пропуска. */
export function myAddress(app: Pick<App, "address">): string | null {
  const address = app.address();
  return address && userOf(address);
}

/** Имя папки сессии — последнее имя dir в нижнем регистре; домашняя папка — «~». Папка — свойство сессии, проект с ней не связан. */
export function folderOf(dir: unknown): string {
  if (typeof dir !== "string" || dir === "" || dir === "~" || dir === "~/") return "~";
  return (dir.split(/[\\/]/).filter(Boolean).pop() ?? "").toLowerCase();
}

/** Строка «opus · high · main» из записи сессии: модель, усилие, слот. */
export function sessionLine(s: SessionRecord | undefined, withEffort = false): string {
  if (!s) return "";
  return [s.model, withEffort && effortName(s.effort), slotOf(s)?.name].filter(Boolean).join(" · ");
}

/** Какой слот отмечен в строке выбора: выбранный, если он есть на машине; иначе первый (слово пользователя 4 нояб.). Меньше двух — выбирать нечего: решает машина. */
export function slotChoice(names: string[], chosen?: string): string {
  if (names.length < 2) return "";
  return chosen && names.includes(chosen) ? chosen : names[0];
}

/** Единственный слот машины ждёт сброса лимита: строки выбора нет, подпись — эта. */
export function slotWait(slots: Record<string, { wait: number | null }> | null | undefined): string {
  const names = Object.keys(slots ?? {});
  if (names.length !== 1) return "";
  const wait = slots![names[0]].wait;
  return wait ? `${names[0]} · ждёт сброса ${at(wait)}` : "";
}

/** Сессии, у которых сменился account: одно правило для всех модулей. was — что помнит модуль; from нет — сессия ещё не встречалась. */
export function accountChanges(r: { sessions: ReadonlyArray<{ callsign?: string | null; account?: unknown }> }, was: (callsign: string) => string | undefined): Array<{ callsign: string; from?: string; account: string }> {
  return r.sessions.flatMap((s) => {
    if (!s.callsign || typeof s.account !== "string") return [];
    const from = was(s.callsign);
    return from === s.account ? [] : [{ callsign: s.callsign, from, account: s.account }];
  });
}

/** Сессии, у которых аккаунт сменился с прошлого roster: подмену делает Host. known — прошлый аккаунт сессии, правится на месте. */
export function accountChanged(known: Record<string, string>, sessions: ReadonlyArray<{ callsign: string; account?: unknown }>): string[] {
  const changes = accountChanges({ sessions }, (c) => known[c]);
  for (const c of changes) known[c.callsign] = c.account;
  return changes.filter((c) => c.from !== undefined).map((c) => c.callsign);
}

