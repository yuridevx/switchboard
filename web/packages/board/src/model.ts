// Правила «Работы» без состояния: чья сессия, совпал ли фильтр, какие строки у проекта.
import type { SessionRecord } from "@switchboard/web-core";
import { kindOf, machineOf, userOf } from "@switchboard/protocol";
import { NONE } from "@switchboard/records";
import { plural, profileNameOf } from "@switchboard/web-ui";

export type Filter = { id: string; name: string; who?: string[]; projects?: string[]; machines?: string[]; profiles?: string[]; states?: string[] };
export type FilterField = "who" | "projects" | "machines" | "profiles" | "states";
export type Section = { id: string; name: string; callsigns: string[] };
export type View = Record<keyof typeof VIEW, boolean>;
/** Строка с глубиной: дочерняя под родителем. */
export type Line = { callsign: string; depth: number };

export const BUILT_IN: Array<Pick<Filter, "id" | "name">> = [
  { id: "mine", name: "Моё" },
  { id: "all", name: "Всё" },
];
export const VIEW = { projects: true, group: false, tree: true, dense: false, lamp: true, at: true, owner: true, pin: true, inc: true, badge: true, q: true, unread: true, fail: true, prof: true, model: true, pjlamps: true, grip: true, add: true, fcount: true };

const rank = (s: SessionRecord) => (s.state === "waiting" || s.state === "failed" ? 0 : s.state === "busy" ? 1 : 2);
/** Сначала ждущие вас и упавшие, потом занятые, остальные; внутри — по адресу. */
export const byUrgency = (list: SessionRecord[]): SessionRecord[] => [...list].sort((a, b) => rank(a) - rank(b) || a.callsign.localeCompare(b.callsign));

type Ctx = { sessions: SessionRecord[]; me: string | null; pins: string[] };
const find = (sessions: SessionRecord[], callsign: unknown) => sessions.find((s) => s.callsign === callsign);
const links = (s: SessionRecord) => [s.by, s.parent].filter((x): x is string => typeof x === "string");

/** Почта владельца: устройство, давшее задачу, иначе сессия выше по цепочке. */
export function ownerOf(sessions: SessionRecord[], callsign: string, seen = new Set<string>()): string | null {
  const s = find(sessions, callsign);
  if (!s || seen.has(callsign)) return null;
  seen.add(callsign);
  for (const link of links(s)) {
    const owner = kindOf(link) === "session" ? ownerOf(sessions, link, seen) : userOf(link);
    if (owner) return owner;
  }
  return null;
}

/** Почему сессия моя; не моя — пусто. */
export function whyMine({ sessions, me, pins }: Ctx, callsign: string, seen = new Set<string>()): string {
  if (pins.includes(callsign)) return "закреплена вами";
  const s = find(sessions, callsign);
  if (!s || !me || seen.has(callsign)) return "";
  seen.add(callsign);
  const isMe = (a: unknown) => typeof a === "string" && kindOf(a) !== "session" && userOf(a) === me;
  if (isMe(s.by)) return "задачу дали вы";
  if (isMe(s.parent)) return "открыли вы";
  const mine = links(s).find((l) => kindOf(l) === "session" && whyMine({ sessions, me, pins: [] }, l, seen));
  return mine ? `открыла ваша ${mine}` : "";
}

/** Совпала ли сессия с полем фильтра: внутри поля «или», пустое не сужает. */
function fits(values: string[] | undefined, test: (value: string) => boolean): boolean {
  return !values?.length || values.some(test);
}

export type Facts = { mine(callsign: string): boolean; owner(callsign: string): string | null; project(callsign: string): string };

/** Совпала ли сессия с фильтром: между полями «и». */
export function matches(f: Partial<Filter>, s: SessionRecord, facts: Facts): boolean {
  const { callsign } = s;
  return (
    fits(f.who, (w) => (w === "mine" ? facts.mine(callsign) : facts.owner(callsign) === w)) &&
    fits(f.projects, (p) => facts.project(callsign) === p) &&
    fits(f.machines, (m) => machineOf(callsign) === m) &&
    fits(f.profiles, (p) => profileNameOf(s) === p) &&
    fits(f.states, (x) => s.state === x)
  );
}

/** Дочерние под родителем: порядок секции, глубина. Родитель вне секции — строка верхнего уровня. */
export function tree(callsigns: string[], parentOf: (callsign: string) => unknown): Line[] {
  const here = new Set(callsigns);
  const top = callsigns.filter((c) => !here.has(parentOf(c) as string));
  const lines: Line[] = [];
  const walk = (callsign: string, depth: number) => {
    lines.push({ callsign, depth });
    for (const kid of callsigns) if (parentOf(kid) === callsign) walk(kid, depth + 1);
  };
  for (const c of top) walk(c, 0);
  return lines;
}

/** Сессия и её потомки: едут блоком. */
export function blockOf(callsign: string, sessions: SessionRecord[]): string[] {
  const kids = sessions.filter((s) => s.parent === callsign).map((s) => s.callsign);
  return [callsign, ...kids.flatMap((k) => blockOf(k, sessions))];
}

/** Ряд чипов: записанный порядок, ушедшие пропущены, новые в конец. */
export function chipsOrder(row: string[] | undefined, chips: Array<Pick<Filter, "id" | "name">>) {
  const known = (row ?? []).flatMap((id) => chips.filter((c) => c.id === id));
  return [...known, ...chips.filter((c) => !known.includes(c))];
}

export const fitLine = (sessions: number, projects: number) => `подходит ${sessions} ${plural(sessions, "сессия", "сессии", "сессий")} · ${projects} ${plural(projects, "проект", "проекта", "проектов")}`;

/** Сосед для перестановки стрелками: перед кем встанет проект. */
export function beforeOf(shown: string[], id: string, by: -1 | 1): string | null | undefined {
  const i = shown.indexOf(id);
  const next = i + by;
  if (i < 0 || next < 0 || next >= shown.length || shown[next] === NONE) return undefined;
  return by < 0 ? shown[next] : (shown[next + 1] ?? null);
}
