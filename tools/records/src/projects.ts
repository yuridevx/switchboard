// Проекты: запись fleet.projects одна на флот и отвечает на три вопроса: какие есть проекты, в каком проекте сессия, в каком она порядке.
// В записи есть и сессии машин не на связи, поэтому правка переставляет только свой блок.
export const PROJECTS = "projects";
/** Номер группы «Без проекта»: сюда попадают сессии вне записи и записанные в неё; группа всегда последняя. */
export const NONE = "~";

export type ProjectRec = { id: string; name: string; sessions: string[] };
export type SessionLink = { callsign: string; parent?: string | null };
export type Section = { id: string; name: string; callsigns: string[] };

const noneGroup = (): ProjectRec => ({ id: NONE, name: "Без проекта", sessions: [] });
const noneLast = (recs: ProjectRec[]) => [...recs.filter((r) => r.id !== NONE), ...recs.filter((r) => r.id === NONE)];
const hasNone = (recs: ProjectRec[]) => recs.some((r) => r.id === NONE);

/** Проект сессии: её место в записи, иначе ближайшего записанного предка, иначе «Без проекта». */
export function projectIdOf(recs: ProjectRec[] | undefined, callsign: string, parentOf: (cs: string) => string | null | undefined = () => null): string {
  const visited = new Set<string>();
  let current: string | null | undefined = callsign;
  while (current && !visited.has(current)) {
    const cs: string = current;
    const home = recs?.find((r) => r.sessions.includes(cs));
    if (home) return home.id;
    visited.add(cs);
    current = parentOf(cs);
  }
  return NONE;
}

/** Секции списка: сначала записанные на своих местах, следом незаписанные по имени; пустая «Без проекта» не показывается. */
export function arrange(recs: ProjectRec[] | undefined, list: SessionLink[]): Section[] {
  const all = recs ?? [];
  const links = new Map(list.map((s) => [s.callsign, s]));
  const written = new Set(all.flatMap((r) => r.sessions));
  const loose = [...links.keys()].filter((cs) => !written.has(cs)).sort((a, b) => a.localeCompare(b));
  const homeOf = (cs: string) => projectIdOf(recs, cs, (c) => links.get(c)?.parent);
  return noneLast(hasNone(all) ? all : [...all, noneGroup()])
    .map(({ id, name, sessions }) => ({ id, name, callsigns: [...sessions.filter((cs) => links.has(cs)), ...loose.filter((cs) => homeOf(cs) === id)] }))
    .filter((s) => s.id !== NONE || s.callsigns.length > 0);
}

/** Вставить блок перед before; before в списке нет — в конец. */
function inserted(sessions: string[], block: string[], before: string | null): string[] {
  const at = before ? sessions.indexOf(before) : -1;
  return at < 0 ? [...sessions, ...block] : [...sessions.slice(0, at), ...block, ...sessions.slice(at)];
}

/** Поставить блок в проект: каждая сессия блока остаётся ровно в одном месте записи. */
export function placeSessions(recs: ProjectRec[] | undefined, block: string[], id: string, before: string | null = null): ProjectRec[] {
  const without = (recs ?? []).map((r) => ({ ...r, sessions: r.sessions.filter((cs) => !block.includes(cs)) }));
  const target = id === NONE && !hasNone(without) ? [...without, noneGroup()] : without;
  return target.map((r) => (r.id === id ? { ...r, sessions: inserted(r.sessions, block, before) } : r));
}

/** Бросок на экране среди строк shown: незаписанные строки выше места броска записываются вместе с блоком, иначе блок встал бы над ними. */
export function dropSessions(recs: ProjectRec[] | undefined, block: string[], id: string, before: string | null, shown: string[]): ProjectRec[] {
  const written = recs?.find((r) => r.id === id)?.sessions ?? [];
  if (before && written.includes(before)) return placeSessions(recs, block, id, before);
  const others = shown.filter((cs) => !block.includes(cs));
  const above = before ? others.slice(0, Math.max(others.indexOf(before), 0)) : others;
  const withAbove = placeSessions(recs, above.filter((cs) => !written.includes(cs)), id);
  return placeSessions(withAbove, block, id);
}

/** Переставить проект перед before; before нет — последним из обычных. «Без проекта» не двигается. */
export function moveProject(recs: ProjectRec[] | undefined, id: string, before: string | null = null): ProjectRec[] {
  const all = recs ?? [];
  const moved = all.find((r) => r.id === id);
  if (!moved || id === NONE) return all;
  const others = all.filter((r) => r !== moved);
  const at = before && before !== NONE ? others.findIndex((r) => r.id === before) : -1;
  return noneLast(at < 0 ? [...others, moved] : [...others.slice(0, at), moved, ...others.slice(at)]);
}

/** Новый пустой проект: номер — от имени, занят — с числом; при переименовании номер не меняется. */
export function addProject(recs: ProjectRec[] | undefined, name: string): { recs: ProjectRec[]; id: string } {
  const all = recs ?? [];
  const shown = name.trim();
  const base = shown.toLowerCase().replace(/\s+/g, "-") || "project";
  const taken = (id: string) => id === NONE || all.some((r) => r.id === id);
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  return { id, recs: noneLast([...all, { id, name: shown, sessions: [] }]) };
}

export function renameProject(recs: ProjectRec[] | undefined, id: string, name: string): ProjectRec[] {
  return (recs ?? []).map((r) => (r.id === id && id !== NONE ? { ...r, name: name.trim() } : r));
}

/** Сессии удалённого проекта остаются вне записи и попадают в «Без проекта». */
export function removeProject(recs: ProjectRec[] | undefined, id: string): ProjectRec[] {
  return (recs ?? []).filter((r) => r.id !== id || id === NONE);
}

/** Проект по имени без учёта регистра: агент называет проект именем. */
export function projectByName(recs: ProjectRec[] | undefined, name: string): ProjectRec | undefined {
  const wanted = name.trim().toLowerCase();
  return recs?.find((r) => r.id !== NONE && r.name.toLowerCase() === wanted);
}
