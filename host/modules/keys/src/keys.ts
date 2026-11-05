// Снесено: заглушка модуля, реализация пишется заново.
import type { Module } from "@switchboard/host";

export function make() {
  const module: Module = {};
  return { module, tools: (): Array<{ name: string; handler(args: never, extra: unknown): Promise<unknown> }> => [] };
}
