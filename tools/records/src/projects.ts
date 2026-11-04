// Проекты: одна запись на флот отвечает сразу на три вопроса — какие есть проекты, в каком сессия проекте, в каком она порядке.
// Запись шире экрана: в ней и сессии машин не на связи, поэтому правка вставляет блок и больше ничего из записи не выбрасывает.
/** Раздел записи проектов; полный ключ — fleet.projects. */
export const PROJECTS = "projects";
/** Номер группы «Без проекта»: сессии вне записи и записанные в неё; всегда последняя. */
export const NONE = "~";
const NONE_NAME = "Без проекта";

export type ProjectRec = { id: string; name: string; sessions: string[] };
/** Что записи нужно знать о сессии: дочерняя без своего места стоит в проекте родителя. */
export type SessionLink = { callsign: string; parent?: string | null };
export type Section = { id: string; name: string; callsigns: string[] };

const lastNone = (recs: ProjectRec[]) => [...recs.filter((r) => r.id !== NONE), ...recs.filter((r) => r.id === NONE)];

/** Проект сессии: своё место в записи, иначе проект родителя, иначе «Без проекта». */
export function projectIdOf(recs: ProjectRec[] | undefined, callsign: string, parentOf: (cs: string) => string | null | undefined = () => null): string {
  const seen = new Set<string>();
  for (let cs: string | null | undefined = callsign; cs && !seen.has(cs); cs = parentOf(cs)) {
    seen.add(cs);
    const own = recs?.find((r) => r.sessions.includes(cs!));
    if (own) return own.id;
  }
  return NONE;
}

/** Секции списка в порядке записи: сессии на своих местах; без места — следом по имени; «Без проекта» последним и только с сессиями. */
export function arrange(recs: ProjectRec[] | undefined, list: SessionLink[]): Section[] {
  const here = new Map(list.map((s) => [s.callsign, s]));
  const parentOf = (cs: string) => here.get(cs)?.parent;
  const all = lastNone(recs?.some((r) => r.id === NONE) ? recs : [...(recs ?? []), { id: NONE, name: NONE_NAME, sessions: [] }]);
  const placed = new Set(all.flatMap((r) => r.sessions));
  const loose = list.filter((s) => !placed.has(s.callsign)).sort((a, b) => a.callsign.localeCompare(b.callsign));
  const out = all.map((r) => ({
    id: r.id,
    name: r.name,
    callsigns: [...r.sessions.filter((cs) => here.has(cs)), ...loose.filter((s) => projectIdOf(recs, s.callsign, parentOf) === r.id).map((s) => s.callsign)],
  }));
  return out.filter((x) => x.id !== NONE || x.callsigns.length);
}

/** Поставить сессии блоком в проект перед before; before нет — в конец. Каждая сессия остаётся ровно в одном месте; остальное в записи не трогается. */
export function placeSessions(recs: ProjectRec[] | undefined, block: string[], id: string, before: string | null = null): ProjectRec[] {
  const moved = new Set(block);
  const base = (recs ?? []).map((r) => ({ ...r, sessions: r.sessions.filter((cs) => !moved.has(cs)) }));
  const all = base.some((r) => r.id === id) || id !== NONE ? base : [...base, { id: NONE, name: NONE_NAME, sessions: [] }];
  return all.map((r) => {
    if (r.id !== id) return r;
    const at = before ? r.sessions.indexOf(before) : -1;
    return { ...r, sessions: at < 0 ? [...r.sessions, ...block] : [...r.sessions.slice(0, at), ...block, ...r.sessions.slice(at)] };
  });
}

/**
 * Бросок на экране: блок встаёт перед before среди показанных строк shown. Незаписанные строки, стоящие на экране до места броска,
 * записываются вместе с ним: иначе блок оказался бы выше них. Остальное в записи не трогается.
 */
export function dropSessions(recs: ProjectRec[] | undefined, block: string[], id: string, before: string | null, shown: string[]): ProjectRec[] {
  const written = new Set((recs ?? []).find((r) => r.id === id)?.sessions ?? []);
  if (before && written.has(before)) return placeSessions(recs, block, id, before);
  const rest = shown.filter((cs) => !block.includes(cs));
  const upTo = before ? rest.slice(0, Math.max(rest.indexOf(before), 0)) : rest;
  return placeSessions(placeSessions(recs, upTo.filter((cs) => !written.has(cs)), id), block, id);
}

/** Переставить проект перед before; before нет — в конец перед «Без проекта». «Без проекта» не двигается. */
export function moveProject(recs: ProjectRec[] | undefined, id: string, before: string | null = null): ProjectRec[] {
  const all = recs ?? [];
  const it = all.find((r) => r.id === id);
  if (!it || id === NONE) return all;
  const rest = all.filter((r) => r.id !== id);
  const at = before && before !== NONE ? rest.findIndex((r) => r.id === before) : -1;
  return lastNone(at < 0 ? [...rest, it] : [...rest.slice(0, at), it, ...rest.slice(at)]);
}

/** Новый пустой проект: номер — от имени, занят — с числом; номер не меняется при переименовании. */
export function addProject(recs: ProjectRec[] | undefined, name: string): { recs: ProjectRec[]; id: string } {
  const all = recs ?? [];
  const base = name.trim().toLowerCase().replace(/\s+/g, "-") || "project";
  let id = base;
  for (let n = 2; id === NONE || all.some((r) => r.id === id); n++) id = `${base}-${n}`;
  return { id, recs: lastNone([...all, { id, name: name.trim(), sessions: [] }]) };
}

export const renameProject = (recs: ProjectRec[] | undefined, id: string, name: string): ProjectRec[] => (recs ?? []).map((r) => (r.id === id && id !== NONE ? { ...r, name: name.trim() } : r));

/** Удалить проект: сессии остаются вне записи и попадают в «Без проекта». */
export const removeProject = (recs: ProjectRec[] | undefined, id: string): ProjectRec[] => (recs ?? []).filter((r) => r.id !== id || id === NONE);

/** Проект по имени без учёта регистра; у агента проект всегда имя. */
export const projectByName = (recs: ProjectRec[] | undefined, name: string): ProjectRec | undefined => recs?.find((r) => r.id !== NONE && r.name.toLowerCase() === name.trim().toLowerCase());

