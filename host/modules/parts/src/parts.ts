// Снесено: инструменты сессии parts пишутся заново.
import type { Module } from "@switchboard/host";

export function make(): { module: Module; tools(cwd: string): Array<{ name: string; description: string; handler: (a: never, e: never) => Promise<unknown> }> } {
  return { module: {}, tools: () => [] };
}
