// «Работа»: чистые правила — фильтры, проект сессии, группы по проектам, порядок.
import type { SessionRow } from "@sb/protocol";
import { byUrgency, isMine, machineOfCall, type Picture } from "../store/fleet.ts";

export const STATE_GROUPS: Array<[string, string, SessionRow["state"][]]> = [["wait", "Ждут вас", ["waiting", "failed"]], ["run", "Работают", ["busy", "starting"]], ["idle", "Свободны", ["idle"]], ["down", "Стоят", ["stopped", "stopping"]]];

/** Фильтр списка. Встроенные — «Мои» и «Все»; свои человек собирает сам, они лежат в его настройках. */
export type Filter = { id: string; name: string; who: "mine" | "all"; states?: string[]; projects?: string[]; machines?: string[]; /** кусочки профиля: подходит сессия с любым из названных */ pieces?: string[] };
export const BUILTIN: Filter[] = [{ id: "mine", name: "Мои", who: "mine" }, { id: "all", name: "Все", who: "all" }];
export const NO_PROJECT = "";

/** Проект сессии: записан в её документе; иначе — проект того, кто дал ей задачу (родитель или сессия, которая её открыла). */
export function projectOf(p: Picture, s: SessionRow, seen = new Set<string>()): string {
  if (s.spec.project) return s.spec.project;
  if (seen.has(s.callsign)) return NO_PROJECT;
  seen.add(s.callsign);
  const up = p.sessions[s.spec.parent ?? ""] ?? p.sessions[s.by];
  return up ? projectOf(p, up, seen) : NO_PROJECT;
}

/** Подходит ли сессия под фильтр. Закреплённые входят в «Мои», даже если открыл их другой. */
export function matches(p: Picture, s: SessionRow, f: Filter, pins: string[]): boolean {
  if (f.who === "mine" && !isMine(p, s) && !pins.includes(s.callsign)) return false;
  if (f.states?.length && !STATE_GROUPS.some(([id, , st]) => f.states!.includes(id) && st.includes(s.state))) return false;
  if (f.projects?.length && !f.projects.includes(projectOf(p, s))) return false;
  if (f.machines?.length && !f.machines.includes(machineOfCall(s.callsign))) return false;
  if (f.pieces?.length && !f.pieces.some((x) => s.spec.pieces?.includes(x))) return false;
  return true;
}

/** Строки списка: закреплённые выше, затем свой порядок, затем срочность. */
export function rowsOf(p: Picture, f: Filter, pins: string[], order: string[]): SessionRow[] {
  const rank = (s: SessionRow) => order.indexOf(s.callsign) + 1 || 1e6;
  return Object.values(p.sessions).filter((s) => matches(p, s, f, pins)).sort((a, b) => Number(pins.includes(b.callsign)) - Number(pins.includes(a.callsign)) || rank(a) - rank(b) || byUrgency(a, b));
}

/** Группы по проектам в порядке человека; проекты без места в порядке — после, по имени; «Без проекта» — последней. */
export function groupsOf(p: Picture, rows: SessionRow[], projectOrder: string[], names: Record<string, string>): Array<{ project: string; name: string; rows: SessionRow[] }> {
  const by = new Map<string, SessionRow[]>();
  for (const s of rows) {
    const pr = projectOf(p, s);
    (by.get(pr) ?? (by.set(pr, []), by.get(pr)!)).push(s);
  }
  const rank = (id: string) => (id === NO_PROJECT ? 1e9 : projectOrder.indexOf(id) + 1 || 1e6);
  return [...by].map(([project, list]) => ({ project, name: names[project] ?? (project || "Без проекта"), rows: list })).sort((a, b) => rank(a.project) - rank(b.project) || a.name.localeCompare(b.name, "ru"));
}

/** Переставить: moved встаёт перед before; before null — в конец. */
export function reorder(list: string[], moved: string, before: string | null): string[] {
  const next = list.filter((x) => x !== moved);
  const at = before === null ? -1 : next.indexOf(before);
  if (at < 0) next.push(moved);
  else next.splice(at, 0, moved);
  return next;
}

/** Сдвинуть элемент списка на шаг: вверх (-1) или вниз (1). */
export function shift<T>(list: T[], item: T, d: -1 | 1): T[] {
  const next = [...list], i = next.indexOf(item), j = i + d;
  if (i < 0 || j < 0 || j >= next.length) return next;
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** Куда упала строка: над какой строкой (или в конец) и в какой группе. rects — видимые строки сверху вниз, y — координата указателя. */
export function dropTarget(rects: Array<{ id: string; group: string; top: number; bottom: number }>, groups: Array<{ group: string; top: number; bottom: number }>, y: number): { before: string | null; group: string; lineY: number } | null {
  if (!groups.length) return null;
  const g = groups.find((x) => y >= x.top && y <= x.bottom) ?? (y < groups[0]!.top ? groups[0]! : groups.at(-1)!);
  const rows = rects.filter((r) => r.group === g.group);
  for (const r of rows) if (y < (r.top + r.bottom) / 2) return { before: r.id, group: g.group, lineY: r.top };
  return { before: null, group: g.group, lineY: rows.length ? rows.at(-1)!.bottom : g.bottom };
}

/** Строка дерева списка: сессия, её глубина под родителем и ведомый, если она ведёт пару. */
export type TreeRow = { s: SessionRow; depth: number; wing?: SessionRow; /** под строкой есть дочерние: её можно свернуть */ kids?: true; /** строка свёрнута: потомки, которых она прячет */ folded?: SessionRow[] };

/** Под кем сессия стоит в списке: родитель из её документа. Его ставит машина при открытии и снимает session.update с parent: null — тогда сессия стоит в корне проекта. */
export const parentOf = (_p: Picture, s: SessionRow): string | undefined => (s.spec.parent && s.spec.parent !== s.callsign ? s.spec.parent : undefined);

/** Дерево списка: ведомый своей строкой не стоит — он виден в строке ведущего; дочерние идут под родителем с отступом. nested false — без отступов, пары всё равно одной строкой.
 * closed — свёрнутые строки: их потомки в список не идут, а лежат у строки в folded. */
export function treeOf(p: Picture, rows: SessionRow[], nested = true, closed: string[] = []): TreeRow[] {
  const here = new Set(rows.map((s) => s.callsign));
  const hidden = (s: SessionRow) => !!s.lead && here.has(s.lead);
  const up = (s: SessionRow) => {
    const u = parentOf(p, s);
    return u && here.has(u) ? u : undefined;
  };
  const out: TreeRow[] = [];
  const seen = new Set<string>();
  const put = (s: SessionRow, depth: number, into?: SessionRow[]) => {
    if (seen.has(s.callsign)) return;
    seen.add(s.callsign);
    const kids = nested ? rows.filter((c) => !hidden(c) && up(c) === s.callsign && !seen.has(c.callsign)) : [];
    // под свёрнутой строкой: потомок в список не идёт, его держит свёрнутый предок
    if (into) return void (into.push(s), kids.forEach((c) => put(c, depth, into)));
    const wing = s.spec.wing ? p.sessions[s.spec.wing] : undefined;
    const folded = kids.length && closed.includes(s.callsign) ? [] : undefined;
    out.push({ s, depth, ...(wing ? { wing } : {}), ...(kids.length ? { kids: true as const } : {}), ...(folded ? { folded } : {}) });
    for (const c of kids) put(c, depth + 1, folded);
  };
  for (const s of rows) if (!hidden(s) && !(nested && up(s))) put(s, 0);
  // круг «кто кого открыл» не теряет строк
  for (const s of rows) if (!hidden(s)) put(s, 0);
  return out;
}

/** Что светится у свёрнутого — проекта или родителя: сессии, которые ждут человека, упали или работают. */
export const litOf = (rows: SessionRow[]): SessionRow[] => rows.filter((s) => s.state === "waiting" || s.state === "failed" || s.state === "busy").slice(0, 8);

/** Строка списка, в которой стоит сессия: её собственная; у ведомого — строка ведущего; у спрятанной под свёрнутым родителем — строка этого родителя. */
export const holderOf = (tree: TreeRow[], callsign: string): string | undefined => tree.find((r) => r.s.callsign === callsign || r.wing?.callsign === callsign || r.folded?.some((s) => s.callsign === callsign))?.s.callsign;

/** Почему сессия в «Моих»: открыл я, открыла моя сессия или я её закрепил. Чужая и не закреплённая — пусто. */
export function whyMine(p: Picture, s: SessionRow, pins: string[]): string {
  const me = p.you;
  if (!me) return "";
  if (s.by === me.addr || s.by === me.person || s.by.endsWith(me.person)) return "вы открыли";
  const parent = p.sessions[s.by];
  if (parent && isMine(p, parent)) return `открыла ваша сессия ${parent.callsign}`;
  return pins.includes(s.callsign) ? "вы закрепили" : "";
}

/** Группы по машинам: тот же список, другой разрез. */
export function groupsByMachine(rows: SessionRow[], name: (machine: string) => string = (m) => m): Array<{ project: string; name: string; rows: SessionRow[] }> {
  const by = new Map<string, SessionRow[]>();
  for (const s of rows) {
    const m = machineOfCall(s.callsign);
    (by.get(m) ?? (by.set(m, []), by.get(m)!)).push(s);
  }
  return [...by].map(([m, list]) => ({ project: "@" + m, name: name(m), rows: list })).sort((a, b) => a.name.localeCompare(b.name, "ru"));
}
