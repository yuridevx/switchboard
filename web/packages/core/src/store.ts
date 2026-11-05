// Снесено.
const razed: any = () => {
  throw new Error("снесено");
};
export const idbStore: any = razed;
export const memoryStore: any = razed;
export type Store = any;
