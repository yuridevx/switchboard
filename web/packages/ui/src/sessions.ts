// Чтение roster: запись сессии, имена, машины с запросами.
import { nameOf, userOf } from "@switchboard/protocol";
import type { SessionRecord } from "@switchboard/relay";
import type { App } from "./app.ts";
import { effortName, stateLabel } from "./labels.ts";
import { slotWaitText } from "./time.ts";

type Marked = Pick<App, "mark">;
type Rostered = Pick<App, "roster">;

/** Имя на экране: своё от человека или из адреса. */
export type Shown = { text: string; human: boolean };

export const plainSession = (callsign: string): Shown => ({ text: nameOf(callsign), human: false });
export const plainMachine = (machine: string): Shown => ({ text: `@${machine}`, human: false });
export const sessionLabel = (app: Marked, callsign: string) => (app.mark("label.session", callsign) as Shown | undefined) ?? plainSession(callsign);
export const machineLabel = (app: Marked, machine: string) => (app.mark("label.machine", machine) as Shown | undefined) ?? plainMachine(machine);

export const sessionOf = (app: Rostered, callsign: string) => app.roster()?.sessions.find((s) => s.callsign === callsign);

/** Машины, у которых в contract есть все эти запросы. */
export const machinesWith = (app: Rostered, ...names: string[]) => (app.roster()?.machines ?? []).filter((m) => names.every((n) => Object.hasOwn(m.contract ?? {}, n))).map((m) => m.machine);

export const slotOf = (s?: SessionRecord) => s?.slot as { name?: string; wait?: number | null } | null | undefined;
export const incidentOf = (s?: SessionRecord) => s?.incident as { type?: string; key?: string } | null | undefined;
export const remoteOf = (s?: SessionRecord) => (typeof s?.remote === "string" ? s.remote : (s?.remote as { url?: string } | undefined)?.url);
export const profileName = (id: string) => id.slice(id.lastIndexOf("/") + 1);
export const profileIdOf = (s?: SessionRecord) => (s?.profile as { id?: string } | null | undefined)?.id;
export function profileNameOf(s?: SessionRecord) {
  const id = profileIdOf(s);
  return id && profileName(id);
}

/** Ведомый пары: в списке и для других сессий его нет, он виден только через своего ведущего. */
export const isWing = (s?: SessionRecord): boolean => (s as { wing?: boolean } | undefined)?.wing === true;
/** Ведомый этой сессии: wing и parent — единственный способ найти пару. */
export const wingOf = (sessions: readonly SessionRecord[], lead: string): SessionRecord | undefined => sessions.find((x) => isWing(x) && x.parent === lead);

export const lamp = (s: SessionRecord) => stateLabel(s.state).dot || "stop";
export const failText = (s: SessionRecord) => Object.entries((s.failed ?? {}) as Record<string, unknown>).map(([part, why]) => `${part}: ${String(why)}`).join("; ");

export function sessionLine(s: SessionRecord | undefined, withEffort = false) {
  return s ? [s.model, withEffort && effortName(s.effort), slotOf(s)?.name].filter(Boolean).join(" · ") : "";
}

/** Адрес человека: всех его устройств. */
export function myAddress(app: Pick<App, "address">) {
  const own = app.address();
  return own && userOf(own);
}

/** Папка сессии: последнее имя в нижнем регистре. */
export function folderOf(dir: unknown) {
  if (typeof dir !== "string" || dir === "" || dir === "~" || dir === "~/") return "~";
  return (dir.split(/[\\/]/).filter(Boolean).pop() ?? "").toLowerCase();
}

/** Какой слот отмечен: выбранный, если он есть на машине; иначе первый (слово пользователя 4 нояб.). Меньше двух — решает машина. */
export function slotChoice(names: string[], chosen?: string) {
  if (names.length < 2) return "";
  return chosen && names.includes(chosen) ? chosen : names[0];
}

export function slotWait(slots: Record<string, { wait: number | null }> | null | undefined) {
  const names = Object.keys(slots ?? {});
  const wait = names.length === 1 ? slots![names[0]].wait : null;
  return wait ? slotWaitText(names[0], wait) : "";
}

/** Сессии с другим аккаунтом, чем был; первый раз тоже здесь: from пусто. */
export function accountChanges(r: { sessions: ReadonlyArray<{ callsign?: string | null; account?: unknown }> }, was: (callsign: string) => string | undefined) {
  return r.sessions.flatMap((s) => {
    if (!s.callsign || typeof s.account !== "string") return [];
    const from = was(s.callsign);
    return from === s.account ? [] : [{ callsign: s.callsign, from, account: s.account }];
  });
}

/** Смены аккаунта: known запоминает новые, первый раз — не смена. */
export function accountChanged(known: Record<string, string>, sessions: ReadonlyArray<{ callsign: string; account?: unknown }>) {
  const changes = accountChanges({ sessions }, (c) => known[c]);
  for (const c of changes) known[c.callsign] = c.account;
  return changes.filter((c) => c.from !== undefined).map((c) => c.callsign);
}
