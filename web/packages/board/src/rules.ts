// Правила «Работы» без экрана: порядок сессий и проектов, дерево по parent, фильтр, место в закреплённых.
import { profileName, type SessionRecord } from "@switchboard/web-core";
import { kindOf, machineOf } from "@switchboard/protocol";

/** Порядок: ждёт вас и сбой, работает, остальные. */
export const rank = (s: SessionRecord) => (s.state === "waiting" || s.state === "failed" ? 0 : s.state === "busy" || s.state === "starting" ? 1 : 2);
export const byRank = (a: SessionRecord, b: SessionRecord) => rank(a) - rank(b) || a.callsign.localeCompare(b.callsign);
export const profileOf = (s: SessionRecord) => {
  const id = (s.profile as { id?: string } | null | undefined)?.id;
  return id ? profileName(id) : undefined;
};
export const incidentOf = (s: SessionRecord) => (s.incident as { type?: string } | null | undefined)?.type;

/** Родитель-сессия из поля parent; устройство и машина — не родитель для дерева. */
export const parentOf = (s: SessionRecord) => (typeof s.parent === "string" && kindOf(s.parent) === "session" && s.parent !== s.callsign ? s.parent : null);

/** Порядок дерева: дочь сразу под родителем, глубина — отступ; родителя нет в списке — дочь в корне. */
export function tree(list: SessionRecord[]): Array<[SessionRecord, number]> {
  const here = new Set(list.map((s) => s.callsign));
  const kids = new Map<string, SessionRecord[]>();
  const roots: SessionRecord[] = [];
  for (const s of [...list].sort(byRank)) {
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

export type Project = { name: string; ss: SessionRecord[]; r: number };

/** Проекты: закреплённые сверху в порядке человека; остальные — ждут вас, работают, по имени. */
export function orderProjects(list: Project[], top: string[]): Project[] {
  const at = (n: string) => {
    const i = top.indexOf(n);
    return i < 0 ? Infinity : i;
  };
  return [...list].sort((a, b) => (at(a.name) === at(b.name) ? a.r - b.r || a.name.localeCompare(b.name) : at(a.name) - at(b.name)));
}

/** Новый порядок закреплённых: name среди видимых vis на месте k; k null — открепить. Невидимые в этом фильтре не сдвигаются. */
export function placeTop(top: string[], name: string, vis: string[], k: number | null): string[] {
  const t = top.filter((x) => x !== name);
  const v = vis.filter((x) => x !== name);
  if (k === null) return t;
  if (k < v.length) t.splice(t.indexOf(v[k]), 0, name);
  else if (v.length) t.splice(t.indexOf(v[v.length - 1]) + 1, 0, name);
  else t.unshift(name);
  return t;
}
