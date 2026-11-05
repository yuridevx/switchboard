// Снесено: заглушка на время сноса.
import type { BrowserPush } from "./store.ts";
export const createAlerts = (_b?: BrowserPush) => (_app: unknown): any => ({ screens: {}, marks: {}, store: [], start() { throw new Error("снесено"); } });
