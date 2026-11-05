// Снесено: заглушка контракта до реализации.
const gone = (): never => {
  throw new Error("снесено");
};
export const clientPath = (_path: string, _home?: string): string | null => gone();
export const claudeDir = (): string => gone();
export const tildePath = (_path: string, _home?: string): string => gone();
