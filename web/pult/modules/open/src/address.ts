// Правила адреса новой сессии: чистые функции. Папка в адресе и есть место сессии; список папок только подсказывает.
import type { SessionRecord } from "@switchboard/web-core";

export const HOME = "~";

/** Ответ о родителе адреса: что в нём лежит или слово отказа. */
export type Listing = { m: string; parent: string; dirs: string[]; word: string } | null;

/** Адрес → родитель и хвост: набранное после последней косой черты фильтрует список родителя. */
export function splitAddr(addr: string): { parent: string; tail: string } {
  const a = addr.trim().replace(/\\/g, "/");
  const i = a.lastIndexOf("/");
  if (i < 0) return { parent: a || HOME, tail: "" };
  const head = a.slice(0, i);
  return { parent: i === 0 ? "/" : /^[A-Za-z]:$/.test(head) ? `${head}/` : head, tail: a.slice(i + 1) };
}

/** Адрес без косой черты в конце — папка сессии. */
export function dirOfAddr(addr: string): string {
  const a = addr.trim().replace(/\\/g, "/");
  return a.length > 1 && !/^[A-Za-z]:\/$/.test(a) ? a.replace(/\/+$/, "") : a;
}

export const into = (parent: string, name: string) => `${parent.replace(/\/+$/, "")}/${name}/`;

export const dirOf = (s: SessionRecord) => (typeof s.dir === "string" && s.dir ? s.dir : HOME);

/** Папки родителя под набранный хвост; скрытые видны, когда имя начато с точки. */
function matching(dirs: string[], tail: string): string[] {
  const t = tail.toLowerCase();
  return dirs.filter((d) => (t.startsWith(".") || !d.startsWith(".")) && d.toLowerCase().startsWith(t));
}

/** Что видно по адресу: список родителя под хвост и пометка «новая папка» — только подсказка, решает машина. */
export function addrView(addr: string, machine: string, list: Listing) {
  const { parent, tail } = splitAddr(addr);
  const listed = list && list.m === machine && list.parent === parent ? list : null;
  const shown = listed ? matching(listed.dirs, tail) : [];
  const isNew = !!listed && (listed.word === "not_found" || (!listed.word && !!tail && !listed.dirs.some((d) => d.toLowerCase() === tail.toLowerCase())));
  return { parent, tail, listed, shown, isNew };
}
