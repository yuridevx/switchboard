// То, что вид ядра читает у ядра: снимок состояния, разделы и действия. Компоненты берут это из контекста.
import { createContext, useContext } from "react";
import type { ScreenEntry } from "../mod.ts";
import type { Hit } from "../nav.ts";
import type { Registry } from "../registry.ts";
import type { CoreState } from "../state.ts";
import type { App, Head, Params, Screen } from "../types.ts";

export type { Hit };

export type Core = {
  wide: boolean;
  brand?: string;
  win: Window;
  use<T>(select: () => T): T;
  state(): CoreState;
  keyLabel(): string;
  lookup(screen: string): ScreenEntry | undefined;
  /** может ли модуль этого App открыть экран */
  mayOpen(app: App, screen: string): boolean;
  fail: Registry["fail"];
  reload(): void;
  /** стереть пропуск и данные приложения на устройстве */
  wipe(): Promise<void>;
  /** принять вставленное приглашение: причина отказа или null */
  acceptInvite(value: string): Promise<string | null>;
  head(screen: string, params: Params): Head;
  sections(): Array<[string, ScreenEntry]>;
  countOf(s: ScreenEntry): number | null;
  groupOf(d: Screen): string | undefined;
  hits(q: string): Hit[];
  go(screen: string, params: Params): void;
  back(): void;
  reconnectNow(): void;
};

export const CoreCtx = createContext<Core | null>(null);
export const useCore = (): Core => useContext(CoreCtx)!;

/** Связь флота → пилюля. */
export const connPill = (conn: string) => (conn === "open" ? { text: "на связи", tone: "ok" as const } : conn === "closed" ? { text: "нет связи", tone: "bad" as const } : { text: "подключаюсь", tone: "wait" as const });
