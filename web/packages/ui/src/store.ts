// Снесено.
const razed: any = () => {
  throw new Error("снесено");
};
export const createStore: any = razed;
export type Store<S = any> = any;
