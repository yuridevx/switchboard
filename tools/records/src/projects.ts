// Запись проектов области флота: порядок сессий живёт в ней, экран только отбирает видимых. «Без проекта» — всегда последняя запись.
export const PROJECTS = "projects";
export const NONE = "~";
const NONE_NAME = "Без проекта";

export type ProjectRec = { id: string; name: string; sessions: string[] };
type Recs = ProjectRec[] | undefined;
type Parent = (callsign: string) => string | null | undefined;

/** Вставка перед номером at; номера нет — в конец. */
const insert = <T,>(list: T[], at: number, items: T[]) => void list.splice(at < 0 ? list.length : at, 0, ...items);

/** Проект сессии: своя запись, иначе запись ближайшего предка. */
export function projectIdOf(recs: Recs, callsign: string, parentOf: Parent = () => null): string {
  const seen = new Set<string>();
  for (let c: string | null | undefined = callsign; c && !seen.has(c); c = parentOf(c)) {
    seen.add(c);
    const rec = recs?.find((r) => r.sessions.includes(c!));
    if (rec) return rec.id;
  }
  return NONE;
}

/** Секции списка: записанные сессии в порядке записи, незаписанные следом по имени. Пустая «Без проекта» не показывается. */
export function arrange(recs: Recs, shown: Array<{ callsign: string; parent?: string | null }>): Array<{ id: string; name: string; callsigns: string[] }> {
  const parents = new Map(shown.map((s) => [s.callsign, s.parent]));
  const all = recs?.some((r) => r.id === NONE) ? recs : [...(recs ?? []), { id: NONE, name: NONE_NAME, sessions: [] }];
  const sections = all.map(({ id, name, sessions }) => ({ id, name, callsigns: sessions.filter((c) => parents.has(c)) }));
  const recorded = new Set(all.flatMap((r) => r.sessions));
  for (const c of [...parents.keys()].sort((a, b) => a.localeCompare(b))) {
    if (!recorded.has(c)) sections.find((s) => s.id === projectIdOf(recs, c, (x) => parents.get(x)))!.callsigns.push(c);
  }
  return sections.filter((s) => s.id !== NONE || s.callsigns.length);
}

/** Поставить сессии в проект перед before, иначе в конец; из других мест записи они уходят. */
export function placeSessions(recs: Recs, block: string[], id: string, before?: string | null): ProjectRec[] {
  const out = (recs ?? []).map((r) => ({ ...r, sessions: r.sessions.filter((c) => !block.includes(c)) }));
  if (id === NONE && !out.some((r) => r.id === NONE)) out.push({ id: NONE, name: NONE_NAME, sessions: [] });
  const target = out.find((r) => r.id === id);
  if (target) insert(target.sessions, target.sessions.indexOf(before as string), block);
  return out;
}

/**
 * Бросок на экране: shown — строки секции сверху вниз. Перед записанной строкой — обычная постановка;
 * иначе порядок держат незаписанные строки выше места: они записываются вместе с брошенными, нижние остаются незаписанными.
 */
export function dropSessions(recs: Recs, block: string[], id: string, before: string | null, shown: string[]): ProjectRec[] {
  const recorded = recs?.find((r) => r.id === id)?.sessions ?? [];
  if (before !== null && recorded.includes(before)) return placeSessions(recs, block, id, before);
  const above = shown.slice(0, before === null ? undefined : Math.max(shown.indexOf(before), 0));
  return placeSessions(recs, [...above.filter((c) => !recorded.includes(c) && !block.includes(c)), ...block], id);
}

export function projectByName(recs: Recs, name: string): ProjectRec | undefined {
  const wanted = name.trim().toLowerCase();
  return recs?.find((r) => r.id !== NONE && r.name.toLowerCase() === wanted);
}

/** Новый проект встаёт перед «Без проекта»; номер — из имени, занятый получает следующее число. */
export function addProject(recs: Recs, name: string): { recs: ProjectRec[]; id: string } {
  const base = name.trim().toLowerCase().replace(/\s+/g, "-") || "project";
  const taken = new Set([NONE, ...(recs ?? []).map((r) => r.id)]);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  const out = [...(recs ?? [])];
  insert(out, out.findIndex((r) => r.id === NONE), [{ id, name: name.trim(), sessions: [] }]);
  return { id, recs: out };
}

export const renameProject = (recs: Recs, id: string, name: string): ProjectRec[] => (recs ?? []).map((r) => (r.id === id && id !== NONE ? { ...r, name: name.trim() } : r));

/** Сессии удалённого проекта становятся незаписанными: «Без проекта» их показывает. */
export const removeProject = (recs: Recs, id: string): ProjectRec[] => (recs ?? []).filter((r) => r.id !== id || id === NONE);

/** Переставить проект перед before, иначе последним из обычных. */
export function moveProject(recs: Recs, id: string, before?: string | null): ProjectRec[] {
  const rec = recs?.find((r) => r.id === id);
  if (!rec || id === NONE) return recs ?? [];
  const rest = recs!.filter((r) => r !== rec);
  insert(rest, rest.findIndex((r) => r.id === before || r.id === NONE), [rec]);
  return rest;
}
