// Модуль shell: скрипты bash и PowerShell на любой машине флота. Два дела одного модуля: машина-цель — запросы, машина сессии — инструменты MCP.
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Host, Module } from "@switchboard/host";
import { makeRuns } from "./runs.ts";
import { shellTools } from "./tools.ts";

export function make() {
  let host!: Host;
  const runs = makeRuns(() => host);
  const tools = (me: string) => shellTools(me, () => host);
  const module: Module = {
    start(h) {
      host = h;
    },
    requests: runs.requests,
    session: (s) => ({ mcpServers: { shell: createSdkMcpServer({ name: "shell", version: "1.0.0", tools: tools(s.info.callsign) }) } }),
    stop: runs.stop,
  };
  return { module, tools };
}
