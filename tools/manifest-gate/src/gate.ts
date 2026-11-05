// Гейт манифестов снесён: вход отвечает словом.
export type ConfigKind = "secret" | "var" | "binding";
export type Manifest = { name: string; type: string; version: string; provides: Record<string, number>; uses: Record<string, number>; config: Record<string, ConfigKind>; into?: string[]; imports?: string[]; pkg?: string };
export const nameOf = (_ref: string) => "снесено";
export const ownerOf = (_ref: string) => "снесено";
export const check = (_mods: Manifest[]): string[] => ["снесено"];
export const order = <T extends Manifest>(_mods: T[]): T[] => [];
export const loadRepo = (_root: string): Array<Manifest & { dir: string }> => {
  throw new Error("снесено");
};
