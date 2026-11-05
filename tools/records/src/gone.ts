// Снесено: контракт отвечает отказом до новой реализации.
export const FLEET_PREFIX = "снесено";
export const LABELS = "снесено";
export const PROJECTS = "снесено";
export const NONE = "снесено";
export type Labels = { sessions?: Record<string, string>; machines?: Record<string, string> };
export type ProjectRec = { id: string; name: string; sessions: string[] };
type Answer<T> = { ok: true; result: T } | { ok: false; error: string };
type Door = <T>(name: string, body: Record<string, unknown>) => Promise<Answer<T>>;
export type Settings = {
  ready(): boolean;
  get<T>(section: string): T | undefined;
  read(): Promise<string | null>;
  edit<T>(section: string, fn: (old: T | undefined) => T): Promise<string | null>;
  settled(): Promise<void>;
};
const no = (): never => { throw new Error("снесено"); };
export const labelOf = (_l: Labels | undefined, _a: string): string | undefined => no();
export const setLabel = (_l: Labels | undefined, _a: string, _n: string): Labels => no();
export const arrange = (_r: ProjectRec[] | undefined, _l: Array<{ callsign: string; parent?: string | null }>): Array<{ id: string; name: string; callsigns: string[] }> => no();
export const placeSessions = (_r: ProjectRec[] | undefined, _b: string[], _p: string, _x?: string | null): ProjectRec[] => no();
export const dropSessions = (_r: ProjectRec[] | undefined, _b: string[], _p: string, _x: string | null, _s: string[]): ProjectRec[] => no();
export const moveProject = (_r: ProjectRec[] | undefined, _i: string, _x?: string | null): ProjectRec[] => no();
export const renameProject = (_r: ProjectRec[] | undefined, _i: string, _n: string): ProjectRec[] => no();
export const removeProject = (_r: ProjectRec[] | undefined, _i: string): ProjectRec[] => no();
export const addProject = (_r: ProjectRec[] | undefined, _n: string): { recs: ProjectRec[]; id: string } => no();
export const projectByName = (_r: ProjectRec[] | undefined, _n: string): ProjectRec | undefined => no();
export const projectIdOf = (_r: ProjectRec[] | undefined, _c: string, _p?: (c: string) => string | null | undefined): string => no();
export const settings = (_o: { read: Door; ask: Door; prefix: string; scope?: string; changed?: () => void }): Settings => no();
