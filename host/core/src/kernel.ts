// Снесено: заглушка контракта до реализации.
const gone = (): never => {
  throw new Error("снесено");
};
export type HostConfig = { machine: string; modules?: Record<string, unknown> };
export class StartError extends Error {
  reasons: string[] = [];
}
export class Mod {
  constructor(..._a: unknown[]) {
    gone();
  }
}
export class Kernel {
  [k: string]: any;
  constructor(..._a: unknown[]) {
    gone();
  }
}
