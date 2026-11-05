// Заглушка сноса.
export const PROJECTS = "снесено";
export const NONE = "снесено";
export type ProjectRec = { id: string; name: string; sessions: string[] };
type Recs = ProjectRec[] | undefined;
type Parent = (callsign: string) => string | null | undefined;
const gone = (): never => {
  throw new Error("снесено");
};
export const arrange = (_r: Recs, _on: Array<{ callsign: string; parent?: string | null }>): Array<{ id: string; name: string; callsigns: string[] }> => gone();
export const projectIdOf = (_r: Recs, _c: string, _p?: Parent): string => gone();
export const projectByName = (_r: Recs, _n: string): ProjectRec | undefined => gone();
export const placeSessions = (_r: Recs, _b: string[], _id: string, _before?: string | null): ProjectRec[] => gone();
export const dropSessions = (_r: Recs, _b: string[], _id: string, _before: string | null, _shown: string[]): ProjectRec[] => gone();
export const addProject = (_r: Recs, _n: string): { recs: ProjectRec[]; id: string } => gone();
export const renameProject = (_r: Recs, _id: string, _n: string): ProjectRec[] => gone();
export const removeProject = (_r: Recs, _id: string): ProjectRec[] => gone();
export const moveProject = (_r: Recs, _id: string, _before?: string | null): ProjectRec[] => gone();
