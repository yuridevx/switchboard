// Снесено: инструменты сессии пишутся заново.
import type { Module } from "@switchboard/host";

export function make(): { module: Module; tools(cwd: string): Array<{ name: string; description: string; handler(args: never, extra: never): Promise<unknown> }> } {
  return { module: {}, tools: () => [] };
}
