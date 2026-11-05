// Снесено: заглушка контракта до реализации.
export type Clock = { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
