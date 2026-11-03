// Правила «Работы» без экрана: дерево по parent, фильтр, ранг состояния — только для ламп и поиска. Порядок проектов и строк — в записи (records).
import type { SessionRecord } from "@switchboard/web-core";
import { profileName } from "@switchboard/web-ui";
import { kindOf, machineOf } from "@switchboard/protocol";

/** Ранг состояния: ждёт вас и сбой, работает, остальные. Порядок списка от него не зависит. */
export const rank = (s: SessionRecord) => (s.state === "waiting" || s.state === "failed" ? 0 : s.state === "busy" || s.state === "starting" ? 1 : 2);
export const byRank = (a: SessionRecord, b: SessionRecord) => rank(a) - rank(b) || a.callsign.localeCompare(b.callsign);
export const profileOf = (s: SessionRecord) => {
  const id = (s.profile as { id?: string } | null | undefined)?.id;
  return id ? profileName(id) : undefined;
};
export const incidentOf = (s: SessionRecord) => (s.incident as { type?: string } | null | undefined)?.type;

/** Родитель-сессия из поля parent; устройство и машина — не родитель для дерева. */
export const parentOf = (s: SessionRecord) => (typeof s.parent === "string" && kindOf(s.parent) === "session" && s.parent !== s.callsign ? s.parent : null);

/** Порядок дерева при заданном порядке строк: дочь сразу под родителем, глубина — отступ; родителя нет в списке — дочь в корне. */
export function tree(list: SessionRecord[]): Array<[SessionRecord, number]> {
  const here = new Set(list.map((s) => s.callsign));
  const kids = new Map<string, SessionRecord[]>();
  const roots: SessionRecord[] = [];
  for (const s of list) {
    const p = parentOf(s);
    if (p && here.has(p)) kids.set(p, [...(kids.get(p) ?? []), s]);
    else roots.push(s);
  }
  const out: Array<[SessionRecord, number]> = [];
  const seen = new Set<string>();
  const walk = (s: SessionRecord, d: number) => {
    if (seen.has(s.callsign)) return;
    seen.add(s.callsign);
    out.push([s, d]);
    for (const k of kids.get(s.callsign) ?? []) walk(k, d + 1);
  };
  for (const s of roots) walk(s, 0);
  // родители по кругу — в корень
  for (const s of list) walk(s, 0);
  return out;
}

/** Фильтр: внутри поля — «или», между полями — «и»; пустое поле не сужает. «mine» в who — правило «моё». */
export type Filter = { id: string; name: string; fixed?: boolean; who?: string[]; projects?: string[]; machines?: string[]; profiles?: string[]; states?: string[] };
export type Field = "who" | "projects" | "machines" | "profiles" | "states";
export const FIELDS: Array<[Field, string]> = [
  ["who", "Чьи"],
  ["projects", "Проекты"],
  ["machines", "Машины"],
  ["profiles", "Профили"],
  ["states", "Состояние"],
];
/** «Моё» и «Всё» — в коде, не в настройках. */
export const BUILT: Filter[] = [
  { id: "mine", name: "Моё", who: ["mine"], fixed: true },
  { id: "all", name: "Всё", fixed: true },
];

/** Подходит ли сессия: mine — правило «моё», owner — почта того, кто её завёл. */
export function match(f: Filter, s: SessionRecord, project: string, mine: (s: SessionRecord) => boolean, owner: (s: SessionRecord) => string | null): boolean {
  if (f.who?.length && !f.who.some((x) => (x === "mine" ? mine(s) : owner(s) === x))) return false;
  if (f.projects?.length && !f.projects.includes(project)) return false;
  if (f.machines?.length && !f.machines.includes(machineOf(s.callsign) ?? "")) return false;
  if (f.profiles?.length && !f.profiles.includes(profileOf(s) ?? "")) return false;
  if (f.states?.length && !f.states.includes(String(s.state))) return false;
  return true;
}

/** Ряд фильтров: «Моё», «Всё» и свои — в порядке человека; не поставленные им — следом в порядке появления. */
export function orderFilters(own: Filter[], row: string[]): Filter[] {
  const all = [...BUILT, ...own];
  const at = (f: Filter) => {
    const i = row.indexOf(f.id);
    return i < 0 ? Infinity : i;
  };
  return all.map((f, i) => [f, i] as const).sort((a, b) => (at(a[0]) === at(b[0]) ? a[1] - b[1] : at(a[0]) - at(b[0]))).map(([f]) => f);
}

export type Project = { id: string; name: string; ss: SessionRecord[]; r: number };
