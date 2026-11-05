// Снесено: типы контракта.
export type KPart = { part: string; version?: string; state?: string; pid?: number; restarts?: number; error?: string };
export type KState = { keeper?: string; rev?: number; os?: string; parts?: KPart[] };
export type KeeperAnswers = Record<string, KState | { error: string }>;
