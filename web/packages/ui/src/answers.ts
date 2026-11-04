// Ответы запросов Host, которые читают несколько модулей страниц: одно описание на ответ. Только типы:
// контракты модулей Host страница не импортирует.

/** Окно лимита аккаунта: как прислал accounts машины. */
export type AccountWindow = { utilization: number; resetsAt?: number; at?: number; src?: string };
export type AccountInfo = { login: "ok" | "none" | "pending"; email?: string; plan?: string; checked?: number; limits?: Record<string, AccountWindow> };
export type SlotInfo = { account: string | null; order: string[]; wait: number | null; sessions: string[] };
/** Ответ machine.accounts: аккаунты и слоты машины. Прежний Host слотов не присылает. */
export type AccountsAnswer = { accounts: Record<string, AccountInfo>; slots: Record<string, SlotInfo> };

export type ProfileInfo = { model?: string | null; effort?: string | null; about?: string };
export type ProfileRepo = { state: "ok" | "error" | "conflict"; files?: string[]; error?: string };
/** Ответ machine.profiles. */
export type ProfilesAnswer = { profiles: Record<string, ProfileInfo>; repos: Record<string, ProfileRepo> };

export type JournalRecord = { t: string; part?: string; who?: string; kind?: string; ev?: string; word?: string; why?: string; id?: string };
/** Ответ machine.journal. */
export type JournalAnswer = { records: JournalRecord[]; more: boolean };

/** Модель из ответа supportedModels. */
export type ModelInfo = { value: string; displayName?: string; supportsAutoMode?: boolean };
