// Запись fleet.projects: проекты по порядку, в каждом — сессии по порядку. Функции чистые: старая запись на входе, новая на выходе.
export const PROJECTS = "projects";
/** Номер группы «Без проекта»: в записи появляется при первой постановке, всегда последняя. */
export const NONE = "~";
const NONE_NAME = "Без проекта";

export type ProjectRec = { id: string; name: string; sessions: string[] };
type Recs = ProjectRec[] | undefined;
type ParentOf = (callsign: string) => string | null | undefined;

const noneLast = (recs: ProjectRec[]) => [...recs.filter((r) => r.id !== NONE), ...recs.filter((r) => r.id === NONE)];
/** Вставка перед номером at; номера нет — в конец. */
const inserted = <T,>(list: T[], items: T[], at: number) => {
  const cut = at < 0 ? list.length : at;
  return [...list.slice(0, cut), ...items, ...list.slice(cut)];
};

/** Проект сессии: её запись, иначе запись ближайшего предка, иначе «Без проекта». */
export function projectIdOf(recs: Recs, callsign: string, parentOf?: ParentOf): string {
  const seen = new Set<string>();
  for (let c: string | null | undefined = callsign; c && !seen.has(c); c = parentOf?.(c)) {
    seen.add(c);
    const rec = recs?.find((r) => r.sessions.includes(c as string));
    if (rec) return rec.id;
  }
  return NONE;
}

/** Секции списка: порядок записанных — из записи, незаписанные за ними по имени. «Без проекта» без сессий нет. */
export function arrange(recs: Recs, list: Array<{ callsign: string; parent?: string | null }>) {
  const all = recs ?? [];
  const parents = new Map(list.map((s) => [s.callsign, s.parent]));
  const recorded = new Set(all.flatMap((r) => r.sessions));
  const loose = new Map<string, string[]>();
  for (const c of [...parents.keys()].filter((x) => !recorded.has(x)).sort((a, b) => a.localeCompare(b))) {
    const id = projectIdOf(all, c, (x) => parents.get(x));
    loose.set(id, [...(loose.get(id) ?? []), c]);
  }
  const section = (r: ProjectRec) => ({ id: r.id, name: r.name, callsigns: [...r.sessions.filter((c) => parents.has(c)), ...(loose.get(r.id) ?? [])] });
  const none = section(all.find((r) => r.id === NONE) ?? { id: NONE, name: NONE_NAME, sessions: [] });
  return [...all.filter((r) => r.id !== NONE).map(section), ...(none.callsigns.length ? [none] : [])];
}

/** Поставить сессии блоком в проект перед before, иначе в конец; в записи каждая остаётся в одном месте. */
export function placeSessions(recs: Recs, block: string[], project: string, before?: string | null): ProjectRec[] {
  const rest = (recs ?? []).map((r) => ({ ...r, sessions: r.sessions.filter((c) => !block.includes(c)) }));
  const all = project === NONE && !rest.some((r) => r.id === NONE) ? [...rest, { id: NONE, name: NONE_NAME, sessions: [] }] : rest;
  return all.map((r) => (r.id === project ? { ...r, sessions: inserted(r.sessions, block, before ? r.sessions.indexOf(before) : -1) } : r));
}

/** Бросок на экране: перед записанной строкой — обычная постановка; среди незаписанных блок встаёт за строками выше места броска, поэтому в запись идут они и он. */
export function dropSessions(recs: Recs, block: string[], project: string, before: string | null, shown: string[]): ProjectRec[] {
  const written = recs?.find((r) => r.id === project)?.sessions ?? [];
  if (before && written.includes(before)) return placeSessions(recs, block, project, before);
  const rows = shown.filter((c) => !block.includes(c));
  const above = before ? rows.slice(0, Math.max(rows.indexOf(before), 0)) : rows;
  return placeSessions(placeSessions(recs, above.filter((c) => !written.includes(c)), project), block, project);
}

export function moveProject(recs: Recs, id: string, before?: string | null): ProjectRec[] {
  const all = recs ?? [];
  const moved = all.find((r) => r.id === id);
  if (!moved) return all;
  const rest = all.filter((r) => r !== moved);
  return noneLast(inserted(rest, [moved], rest.findIndex((r) => r.id === before)));
}

export const renameProject = (recs: Recs, id: string, name: string): ProjectRec[] => (recs ?? []).map((r) => (r.id === id && id !== NONE ? { ...r, name: name.trim() } : r));

/** Сессии удалённого проекта становятся незаписанными: их секция теперь «Без проекта». */
export const removeProject = (recs: Recs, id: string): ProjectRec[] => (recs ?? []).filter((r) => r.id !== id || id === NONE);

/** Новый проект перед «Без проекта»; номер — из имени, занятый получает следующее число. */
export function addProject(recs: Recs, name: string): { recs: ProjectRec[]; id: string } {
  const all = recs ?? [];
  const text = name.trim();
  const base = text.toLowerCase().replace(/\s+/g, "-") || "project";
  const taken = new Set([NONE, ...all.map((r) => r.id)]);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return { recs: noneLast([...all, { id, name: text, sessions: [] }]), id };
}

/** Проект по имени без оглядки на регистр; «Без проекта» по имени не находится. */
export function projectByName(recs: Recs, name: string): ProjectRec | undefined {
  const wanted = name.trim().toLowerCase();
  return recs?.find((r) => r.id !== NONE && r.name.toLowerCase() === wanted);
}
