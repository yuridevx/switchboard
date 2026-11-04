// Модуль выпуска в ядре: манифест, объект, его App и причина выключения.
import type { App, AppModule, Command, Manifest, Screen } from "./types.ts";

export type Mod = { m: Manifest; mod: AppModule; app: App; failed: string | null };
/** Экран и модуль-владелец. */
export type ScreenEntry = { owner: Mod; def: Screen };
export type CommandEntry = { owner: Mod; def: Command };
