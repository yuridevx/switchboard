// Снесено: вход контракта отказывает словом, пока не написан новый.
export type ProjectRec = { id: string; name: string; sessions: string[] };
export type Labels = { sessions?: Record<string, string>; machines?: Record<string, string> };
export type Settings = {
  ready(): boolean;
  get<T>(section: string): T | undefined;
  edit<T>(section: string, fn: (old: T | undefined) => T): Promise<string | null>;
  read(): Promise<string | null>;
  settled(): Promise<void>;
};
const gone = (): never => {
  throw new Error("снесено");
};
export const FLEET_PREFIX = "снесено";
export const LABELS = "снесено";
export const PROJECTS = "снесено";
export const NONE = "снесено";
export const labelOf = (_l: Labels | undefined, _to: string): string | undefined => gone();
export const setLabel = (_l: Labels | undefined, _to: string, _text: string): Labels => gone();
export const projectIdOf = (_r: ProjectRec[] | undefined, _c: string, _p?: (cs: string) => string | null | undefined): string => gone();
export const arrange = (_r: ProjectRec[] | undefined, _l: Array<{ callsign: string; parent?: string | null }>): Array<{ id: string; name: string; callsigns: string[] }> => gone();
export const placeSessions = (_r: ProjectRec[] | undefined, _b: string[], _i: string, _before?: string | null): ProjectRec[] => gone();
export const dropSessions = (_r: ProjectRec[] | undefined, _b: string[], _i: string, _before: string | null, _s: string[]): ProjectRec[] => gone();
export const moveProject = (_r: ProjectRec[] | undefined, _i: string, _before?: string | null): ProjectRec[] => gone();
export const addProject = (_r: ProjectRec[] | undefined, _n: string): { recs: ProjectRec[]; id: string } => gone();
export const renameProject = (_r: ProjectRec[] | undefined, _i: string, _n: string): ProjectRec[] => gone();
export const removeProject = (_r: ProjectRec[] | undefined, _i: string): ProjectRec[] => gone();
export const projectByName = (_r: ProjectRec[] | undefined, _n: string): ProjectRec | undefined => gone();
type Ask = <T = unknown>(name: string, body: Record<string, unknown>) => Promise<{ ok: true; result: T } | { ok: false; error: string }>;
export const settings = (_o: { read: Ask; ask: Ask; prefix: string; scope?: string; changed?: () => void }): Settings => gone();
