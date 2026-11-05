// Что строкам ленты нужно от экрана: свёртка, свои отправки, действия. Галерея даёт молчащую замену.
import { createContext, useContext } from "react";
import type { View } from "../fold.ts";
import type { Rewind, Send } from "../talk.ts";

export type Env = {
  cs: string;
  wide: boolean;
  /** сессия живая и машина умеет session.call: кнопки действий видны */
  canAct: boolean;
  view: View;
  sends: Record<string, Send>;
  rewinds: Record<string, Rewind>;
  label: string;
  waiting(toolId: string): boolean;
  act(method: string, args: unknown[]): void;
  again(uuid: string): void;
  cancel(uuid: string): void;
  rewind(uuid: string, apply: boolean): void;
  dropRewind(uuid: string): void;
  fill(text: string): void;
};

export const EnvCtx = createContext<Env | null>(null);
export const useEnv = (): Env => useContext(EnvCtx)!;
