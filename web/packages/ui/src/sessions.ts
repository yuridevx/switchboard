// Запись сессии и машины из roster: что из неё читают экраны, имена, слоты, смена аккаунта.
import { nameOf, userOf } from "@switchboard/protocol";
import type { SessionRecord } from "@switchboard/relay";
import type { App } from "./app.ts";
import { effortName } from "./labels.ts";
import { at } from "./time.ts";

type Marked = Pick<App, "mark">;
type Rostered = Pick<App, "roster">;

/** Подпись имени: человеческое имя или адрес. */
export type Shown = { text: string; human: boolean };

export const sessionOf = (app: Rostered, callsign: string) => app.roster()?.sessions.find((s) => s.callsign === callsign);
/** Подпись сессии без своего имени: имя из позывного. */
export const plainSession = (callsign: string): Shown => ({ text: nameOf(callsign), human: false });
/** Подпись машины без своего имени: адрес. */
export const plainMachine = (machine: string): Shown => ({ text: `@${machine}`, human: false });
/** Имя сессии; модуля имён нет или он упал — как без своего имени. */
export const sessionLabel = (app: Marked, callsign: string) => (app.mark("label.session", callsign) as Shown | undefined) ?? plainSession(callsign);
export const machineLabel = (app: Marked, machine: string) => (app.mark("label.machine", machine) as Shown | undefined) ?? plainMachine(machine);

export const slotOf = (s?: SessionRecord) => s?.slot as { name?: string; wait?: number | null } | null | undefined;
export const incidentOf = (s?: SessionRecord) => s?.incident as { type?: string; key?: string } | null | undefined;
/** Ссылка Remote Control сессии. */
export const remoteOf = (s?: SessionRecord) => (typeof s?.remote === "string" ? s.remote : (s?.remote as { url?: string } | undefined)?.url);
/** Причина сбоя сессии: «часть: причина; …». */
export const failText = (s: SessionRecord) => Object.entries((s.failed as Record<string, string> | undefined) ?? {}).map(([part, why]) => `${part}: ${why}`).join("; ");

/** Короткое имя профиля: team/profiles/ops → ops. */
export const profileName = (id: string) => id.split("/").at(-1) ?? id;
export const profileIdOf = (s?: SessionRecord) => (s?.profile as { id?: string } | null | undefined)?.id;
export const profileNameOf = (s?: SessionRecord) => {
  const id = profileIdOf(s);
  return id ? profileName(id) : undefined;
};

/** Машины на связи, у которых в contract есть все эти запросы; без запросов — все. */
export const machinesWith = (app: Rostered, ...names: string[]) => (app.roster()?.machines ?? []).filter((m) => names.every((n) => m.contract?.[n] !== undefined)).map((m) => m.machine);

/** Мой адрес ~почта — из адреса пропуска. */
export function myAddress(app: Pick<App, "address">): string | null {
  const address = app.address();
  return address ? userOf(address) : null;
}

/** Имя папки сессии — последнее имя dir в нижнем регистре; домашняя папка — «~». Папка — свойство сессии, проект с ней не связан. */
export function folderOf(dir: unknown): string {
  if (typeof dir !== "string" || !dir || dir === "~") return "~";
  return dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop()!.toLowerCase();
}

/** Строка «opus · high · main» из записи сессии: модель, усилие, слот. */
export function sessionLine(s: SessionRecord | undefined, withEffort = false): string {
  if (!s) return "";
  return [s.model, withEffort && s.effort ? effortName(s.effort) : null, slotOf(s)?.name].filter((x) => typeof x === "string" && x).join(" · ");
}

/** Какой слот отмечен в строке выбора: выбранный, если он есть на машине; иначе первый (слово пользователя 4 нояб.). Меньше двух — выбирать нечего: решает машина. */
export function slotChoice(names: string[], chosen = ""): string {
  if (names.length < 2) return "";
  return names.includes(chosen) ? chosen : names[0];
}

/** Единственный слот машины ждёт сброса лимита: строки выбора нет, подпись — эта. */
export function slotWait(slots: Record<string, { wait: number | null }> | null | undefined): string {
  const list = Object.entries(slots ?? {});
  if (list.length !== 1 || !list[0][1].wait) return "";
  return `${list[0][0]} · ждёт сброса ${at(list[0][1].wait)}`;
}

/** Сессии, у которых сменился account: одно правило для всех модулей. was — что помнит модуль; from нет — сессия ещё не встречалась. */
export function accountChanges(r: { sessions: ReadonlyArray<{ callsign?: string | null; account?: unknown }> }, was: (callsign: string) => string | undefined): Array<{ callsign: string; from?: string; account: string }> {
  const out: Array<{ callsign: string; from?: string; account: string }> = [];
  for (const { callsign, account } of r.sessions) {
    if (typeof account !== "string" || !callsign) continue;
    const from = was(callsign);
    if (from !== account) out.push({ callsign, from, account });
  }
  return out;
}

/** Сессии, у которых аккаунт сменился с прошлого roster: подмену делает Host. known — прошлый аккаунт сессии, правится на месте. */
export function accountChanged(known: Record<string, string>, sessions: ReadonlyArray<{ callsign: string; account?: unknown }>): string[] {
  const list = accountChanges({ sessions }, (cs) => known[cs]);
  for (const x of list) known[x.callsign] = x.account;
  return list.filter((x) => x.from !== undefined).map((x) => x.callsign);
}
