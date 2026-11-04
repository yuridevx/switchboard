// Модуль keys: сервер MCP keys в каждой сессии — пропуска флота. invite и list зовут gate, revoke — вход relay;
// ответ — как есть. Секрет пропуска рождается у gate при приёме и сюда не попадает: приглашение — одноразовое.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Host, Module, Result } from "@switchboard/host";

type Text = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const text = (t: string, isError = false): Text => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const answer = (what: string, r: Result): Text => (r.ok ? text(JSON.stringify(r.result, null, 2)) : text(`${what}: ${r.error}`, true));

export function make() {
  let host: Host;

  function tools(): SdkMcpToolDefinition<any>[] {
    return [
      tool(
        "invite",
        "Выдать пропуск флота одноразовым приглашением. Машина — role host и имя машины: приглашение принимает keeper install. Устройство или программа — role client, имя и почта человека: телефон и пульт принимают приглашение ссылкой с #invite=<приглашение> или в поле ввода, программа — switchboard redeem. У адреса один живой пропуск: занят — name_taken, сначала отзовите прежний.",
        {
          role: z.enum(["host", "client"]),
          name: z.string().describe("имя машины, устройства или программы: A-Z a-z 0-9 _ -"),
          person: z.string().optional().describe("почта человека за устройством или программой; у машины нет"),
        },
        async ({ role, name, person }) => answer("keys.invite", await host.request("keys.invite", { role, name, ...(person ? { person } : {}) })),
      ),
      tool(
        "list",
        "Пропуска флота: номер, роль, имя, человек, адрес, состояние (wait — приглашение не принято, ok), кем выдан и когда. role — только принятые этой роли.",
        { role: z.enum(["host", "client"]).optional() },
        async ({ role }) => answer("keys.list", await host.request("keys.list", role ? { role } : {})),
      ),
      tool(
        "revoke",
        "Отозвать пропуск или непринятое приглашение по номеру: отметка у gate, соединения с этим номером закрыты на всех машинах сразу. Пропуска, выданные отозванным, живут — смотрите их по «кем» в list.",
        { kid: z.string().describe("номер пропуска") },
        async ({ kid }) => answer("keys.revoke", await host.request("keys.revoke", { kid })),
      ),
    ];
  }

  const mod: Module = {
    session: () => ({ mcpServers: { keys: createSdkMcpServer({ name: "keys", version: "1.0.0", tools: tools() }) } }),
    start(h) {
      host = h;
    },
    // хранить нечего
    stop() {},
  };
  return { module: mod, tools };
}
