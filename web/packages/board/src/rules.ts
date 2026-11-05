// Правила «Работы» без экрана: дерево сессий, фильтр и его ряд, ранг состояния, вид по умолчанию.
// Порядок проектов и строк — в записи флота (records); ранг нужен только лампам и поиску.
import type { SessionRecord } from "@switchboard/web-core";
import { profileNameOf } from "@switchboard/web-ui";
import { kindOf, machineOf } from "@switchboard/protocol";

/** Ранг состояния: ждёт вас и сбой, работает, остальные. */
export function rank(s: SessionRecord): number {
  if (s.state === "waiting" || s.state === "failed") return 0;
  return s.state === "busy" || s.state === "starting" ? 1 : 2;
}
export const byRank = (a: SessionRecord, b: SessionRecord) => rank(a) - rank(b) || a.callsign.localeCompare(b.callsign);

/** Родитель-сессия из поля parent; устройство и машина для дерева не родитель. */
export function parentOf(s: SessionRecord): string | null {
  return typeof s.parent === "string" && kindOf(s.parent) === "session" && s.parent !== s.callsign ? s.parent : null;
}

/** Строки деревом при заданном порядке: дочь сразу под родителем, число — отступ; родителя нет в списке или родители по кругу — в корень. */
export function tree(list: SessionRecord[]): Array<[SessionRecord, number]> {
  const here = new Set(list.map((s) => s.callsign));
  const kids = new Map<string, SessionRecord[]>();
  for (const s of list) {
    const p = parentOf(s);
    if (p && here.has(p)) kids.set(p, [...(kids.get(p) ?? []), s]);
  }
  const rooted = list.filter((s) => !parentOf(s) || !here.has(parentOf(s)!));
  const out: Array<[SessionRecord, number]> = [];
  const seen = new Set<string>();
  const walk = (s: SessionRecord, depth: number) => {
    if (seen.has(s.callsign)) return;
    seen.add(s.callsign);
    out.push([s, depth]);
    for (const k of kids.get(s.callsign) ?? []) walk(k, depth + 1);
  };
  for (const s of [...rooted, ...list]) walk(s, 0);
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
export function fits(f: Filter, s: SessionRecord, project: string, mine: (s: SessionRecord) => boolean, owner: (s: SessionRecord) => string | null): boolean {
  const among = (values: string[] | undefined, value: string) => !values?.length || values.includes(value);
  if (f.who?.length && !f.who.some((x) => (x === "mine" ? mine(s) : owner(s) === x))) return false;
  return among(f.projects, project) && among(f.machines, machineOf(s.callsign) ?? "") && among(f.profiles, profileNameOf(s) ?? "") && among(f.states, String(s.state));
}

/** Ряд фильтров: «Моё», «Всё» и свои — в порядке человека; не поставленные им — следом в порядке появления. */
export function orderFilters(own: Filter[], row: string[]): Filter[] {
  const place = (f: Filter) => {
    const i = row.indexOf(f.id);
    return i < 0 ? Infinity : i;
  };
  // сортировка устойчива: равные места остаются в порядке появления
  return [...BUILT, ...own].sort((a, b) => (place(a) === place(b) ? 0 : place(a) - place(b)));
}

/** Вид списка — настройка устройства: раздел хранилища view, на сервер не уходит. */
export const VIEW0 = { projects: true, group: false, tree: true, dense: false, lamp: true, at: true, owner: true, pin: true, inc: true, badge: true, q: true, unread: true, fail: true, prof: true, model: true, pjlamps: true, grip: true, add: true, fcount: true };
export type View = typeof VIEW0;

/** Впервые увиденный проект развёрнут, только если в нём ждут вас или сбой. */
export const opensFirst = (r: number) => r === 0;
