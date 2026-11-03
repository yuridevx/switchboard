// Форма новой сессии: снимок и чистые правила адреса. Папка в адресе и есть место сессии; список папок только подсказывает.
import type { SessionRecord } from "@switchboard/web-core";

export const HOME = "~";

export type Slots = Record<string, { account: string | null; wait?: number | null; sessions: string[] }>;
export type Profiles = Record<string, { model?: string | null; effort?: string | null; about?: string }>;
export type Place = { m: string; dir: string };
/** Ответ о родителе адреса: что в нём лежит или слово отказа. */
export type Listing = { m: string; parent: string; dirs: string[]; word: string } | null;

/** Состояние формы: один снимок, правка — новым снимком. */
export type Form = {
  machine: string;
  addr: string;
  name: string;
  nameErr: string;
  err: string;
  profile: string | null;
  profileSet: boolean;
  model: string;
  effort: string;
  modelSet: boolean;
  slot: string;
  r2: boolean;
  text: string;
  sending: boolean;
  pq: string;
  pop: "" | "prof" | "model";
  pickM: boolean;
  list: Listing;
  slots: Slots | null;
  profiles: Profiles | null;
  refused: Record<string, string>;
};

export const EMPTY: Form = { machine: "", addr: HOME, name: "", nameErr: "", err: "", profile: null, profileSet: false, model: "", effort: "", modelSet: false, slot: "", r2: false, text: "", sending: false, pq: "", pop: "", pickM: false, list: null, slots: null, profiles: null, refused: {} };

/** Адрес → родитель и хвост: набранное после последней косой черты фильтрует список родителя. */
export function splitAddr(addr: string): { parent: string; tail: string } {
  const a = addr.trim().replace(/\\/g, "/");
  const i = a.lastIndexOf("/");
  if (i < 0) return { parent: a || HOME, tail: "" };
  return { parent: i === 0 ? "/" : /^[A-Za-z]:$/.test(a.slice(0, i)) ? a.slice(0, i + 1) : a.slice(0, i), tail: a.slice(i + 1) };
}
/** Адрес без косой черты в конце — папка сессии. */
export const dirOfAddr = (addr: string) => {
  const a = addr.trim().replace(/\\/g, "/");
  return a.length > 1 && !/^[A-Za-z]:\/$/.test(a) ? a.replace(/\/+$/, "") : a;
};
export const into = (parent: string, name: string) => `${parent.replace(/\/+$/, "")}/${name}/`;
/** Папки родителя под набранный хвост; скрытые видны, когда имя начато с точки. */
export const matching = (dirs: string[], tail: string) => {
  const t = tail.toLowerCase();
  return dirs.filter((d) => (t.startsWith(".") || !d.startsWith(".")) && d.toLowerCase().startsWith(t));
};
/** Время сброса слота: секунды или миллисекунды эпохи → ЧЧ:ММ. */
export const hm = (t: number) => {
  const d = new Date(t < 1e12 ? t * 1000 : t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
export const dirOf = (s: SessionRecord) => (typeof s.dir === "string" && s.dir ? s.dir : HOME);

/** Что видно по адресу: список родителя под хвост и пометка «новая папка» — только подсказка, решает машина. */
export function addrView(f: Form) {
  const { parent, tail } = splitAddr(f.addr);
  const listed = f.list && f.list.m === f.machine && f.list.parent === parent ? f.list : null;
  const shown = listed ? matching(listed.dirs, tail) : [];
  const isNew = !!listed && (listed.word === "not_found" || (!listed.word && !!tail && !listed.dirs.some((d) => d.toLowerCase() === tail.toLowerCase())));
  return { parent, tail, listed, shown, isNew };
}
