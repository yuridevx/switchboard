// Снесено: инструментов нет, пока модуль не написан заново.
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { Module } from "@switchboard/host";

export function make() {
  const mod: Module = { start() {}, stop() {} };
  return { module: mod, tools: (): SdkMcpToolDefinition<any>[] => [] };
}
