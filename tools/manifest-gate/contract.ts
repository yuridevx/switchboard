// Снесено: вход контракта отвечает отказом до новой реализации.
export type Manifest = {
  name: string;
  type: string;
  version: string;
  provides: Record<string, number>;
  uses: Record<string, number>;
  config: Record<string, "secret" | "var" | "binding">;
  into?: string[];
  pkg?: string;
  imports?: string[];
};
const gone = (): never => {
  throw new Error("снесено");
};
export const nameOf = (_ref: string): string => gone();
export const ownerOf = (_ref: string): string => gone();
export const order = <T extends Manifest>(_mods: T[]): T[] => gone();
export const check = (_mods: Manifest[]): string[] => gone();
export const loadRepo = (_root: string): (Manifest & { dir: string })[] => gone();
