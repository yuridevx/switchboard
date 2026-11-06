// Что строкам ленты нужно от экрана: свёртка, свои отправки, действия. Галерея даёт молчащую замену.
import { createContext, useContext } from "react";
import type { View } from "../fold.ts";
import type { Rewind, Send } from "../talk.ts";

export type Env = {
  cs: string;
  wide: boolean;
  /** сессия жива и машина умеет session.call */
  canAct: boolean;
  view: View;
  sends: Record<string, Send>;
  rewind: Rewind | null;
  label: string;
  /** запрос разрешения этого инструмента ждёт человека */
  waiting(toolId: string): boolean;
  act(method: string, args: unknown[]): void;
  again(uuid: string): void;
  cancel(uuid: string): void;
  probe(uuid: string): void;
  apply(uuid: string): void;
  cancelRewind(): void;
  fill(text: string): void;
};

export const EnvCtx = createContext<Env | null>(null);
export const useEnv = (): Env => useContext(EnvCtx)!;
