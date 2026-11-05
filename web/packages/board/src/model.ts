// Правила списка: чья сессия, что подходит под фильтр, порядок чипов и строк. Чистые функции над записями сессий.
import { kindOf, machineOf, userOf } from "@switchboard/protocol";
import type { SessionRecord } from "@switchboard/relay";
import { profileNameOf } from "@switchboard/web-ui";

export const MINE = "mine";
export const ALL = "all";

/** Свой фильтр: запись web-board.filters у почты. Пустое поле не сужает. */
export type Filter = { id: string; name: string; who?: string[]; projects?: string[]; machines?: string[]; profiles?: string[]; states?: string[] };
export type Field = "who" | "projects" | "machines" | "profiles" | "states";

/** Единицы вида: группа и её [ключ, подпись, полное название]. */
export const VIEW_GROUPS: Array<[string, Array<[string, string, string]>]> = [
  ["Список", [["projects", "По проектам", "Группировать по проектам"], ["group", "По машинам", "Группы по машинам в проекте"], ["tree", "Дочерние", "Дочерние под родителем"], ["dense", "В одну строку", "В одну строку"]]],
  ["Строка", [["lamp", "Лампа", "Лампа состояния"], ["at", "Машина", "Машина"], ["owner", "Владелец", "Владелец чужой сессии"], ["pin", "Закрепление", "Значок закрепления"], ["inc", "Инцидент", "Инцидент"], ["badge", "«?» и число", "Значок вопроса и непрочитанного"], ["q", "Вопрос", "Текст вопроса"], ["unread", "Непрочитанное", "Текст непрочитанного"], ["fail", "Сбой", "Причина сбоя"], ["prof", "Профиль", "Профиль"], ["model", "Модель", "Модель"]]],
  ["Проект", [["pjlamps", "Лампы", "Лампы свёрнутого проекта"], ["grip", "Ручка", "Ручка перетаскивания"], ["add", "«+»", "Кнопка новой сессии"]]],
  ["Фильтры", [["fcount", "Число", "Число сессий в фильтре"]]],
];
export type View = Record<string, boolean>;
const OFF_BY_DEFAULT = ["group", "dense"];
export const DEFAULT_VIEW: View = Object.fromEntries(VIEW_GROUPS.flatMap(([, units]) => units.map(([key]) => [key, !OFF_BY_DEFAULT.includes(key)])));

type Find = (callsign: string) => SessionRecord | undefined;
const word = (v: unknown) => (typeof v === "string" ? v : "");
/** Адрес из поля, если это сессия. */
const sessionIn = (v: unknown) => (kindOf(v) === "session" ? word(v) : "");

/** Почта владельца: устройство, давшее задачу, иначе сессия выше по цепочке. */
export function ownerOf(callsign: string, find: Find, seen = new Set<string>()): string | null {
  const s = find(callsign);
  if (!s || seen.has(callsign)) return null;
  seen.add(callsign);
  if (kindOf(s.by) === "device") return userOf(word(s.by));
  const above = sessionIn(s.by) || sessionIn(s.parent);
  return above ? ownerOf(above, find, seen) : null;
}

/** Почему сессия моя; не моя — "". */
export function whyMine(callsign: string, o: { find: Find; me: string | null; pins: string[] }, seen = new Set<string>()): string {
  if (o.pins.includes(callsign)) return "закреплена вами";
  const s = o.find(callsign);
  if (!s || !o.me || seen.has(callsign)) return "";
  seen.add(callsign);
  const isMe = (address: unknown) => kindOf(address) === "device" && userOf(word(address)) === o.me;
  if (isMe(s.by)) return "задачу дали вы";
  if (isMe(s.parent)) return "открыли вы";
  const above = [sessionIn(s.parent), sessionIn(s.by)].find((x) => x && whyMine(x, o, seen));
  return above ? `открыла ваша ${above}` : "";
}

/** Подходит ли сессия: внутри поля — «или», между полями — «и». */
export function fits(f: Filter, s: SessionRecord, t: { mine: boolean; owner: string | null; project: string }): boolean {
  const any = (values: string[] | undefined, ok: (v: string) => boolean) => !values?.length || values.some(ok);
  return any(f.who, (w) => (w === MINE ? t.mine : w === t.owner)) && any(f.projects, (p) => p === t.project) && any(f.machines, (m) => m === machineOf(s.callsign)) && any(f.profiles, (p) => p === profileNameOf(s)) && any(f.states, (x) => x === s.state);
}

/** Сначала ждущие вас и упавшие, потом занятые, остальные; внутри — по адресу. */
export function byUrgency(list: SessionRecord[]): SessionRecord[] {
  const rank = (s: SessionRecord) => (s.state === "waiting" || s.state === "failed" ? 0 : s.state === "busy" ? 1 : 2);
  return [...list].sort((a, b) => rank(a) - rank(b) || (a.callsign < b.callsign ? -1 : 1));
}

/** Чипы по порядку: записанный ряд без пропавших, следом остальные. */
export function chipOrder(filters: Filter[], row: string[] | undefined): string[] {
  const all = [MINE, ALL, ...filters.map((f) => f.id)];
  const listed = (row ?? []).filter((id) => all.includes(id));
  return [...listed, ...all.filter((id) => !listed.includes(id))];
}

/** Строки раздела: дочерняя — сразу под родителем, если он на экране; tree выключен — ровно. */
export function placeRows(callsigns: string[], parentOf: (cs: string) => unknown, tree: boolean): Array<{ callsign: string; depth: number }> {
  if (!tree) return callsigns.map((callsign) => ({ callsign, depth: 0 }));
  const shown = new Set(callsigns);
  const out: Array<{ callsign: string; depth: number }> = [];
  const put = (callsign: string, depth: number) => {
    out.push({ callsign, depth });
    for (const kid of callsigns) if (parentOf(kid) === callsign) put(kid, depth + 1);
  };
  for (const cs of callsigns) if (!shown.has(word(parentOf(cs)))) put(cs, 0);
  return out;
}
