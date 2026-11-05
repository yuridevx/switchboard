// Пропуска флота из разговора: инструменты MCP сессии. invite и list зовут gate, revoke — вход relay; своего состояния нет.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Host, Module, Result } from "@switchboard/host";
import { z } from "zod";

const ROLE = z.enum(["host", "client"]);

export function make() {
  let host: Host;

  const answer = (name: string, r: Result) =>
    r.ok
      ? { content: [{ type: "text" as const, text: JSON.stringify(r.result, null, 2) }] }
      : { content: [{ type: "text" as const, text: `${name}: ${r.error}` }], isError: true };

  const tools = () => [
    tool(
      "invite",
      "Выдать пропуск флота одноразовым приглашением. Машина — role host и имя машины: приглашение принимает keeper install. Устройство или программа — role client, имя и почта человека: телефон и пульт принимают приглашение ссылкой с #invite=<приглашение> или в поле ввода, программа — switchboard redeem. У адреса один живой пропуск: занят — name_taken, сначала отзовите прежний.",
      {
        role: ROLE,
        name: z.string().describe("имя машины, устройства или программы: A-Z a-z 0-9 _ -"),
        person: z.string().optional().describe("почта человека за устройством или программой; у машины нет"),
      },
      // пустая почта у машины — то же, что её нет: модель заполняет необязательные поля
      async ({ role, name, person }) => answer("keys.invite", await host.request("keys.invite", { role, name, person: person || undefined })),
    ),
    tool(
      "list",
      "Пропуска флота: номер, роль, имя, человек, адрес, состояние (wait — приглашение не принято, ok), кем выдан и когда. role — только принятые этой роли.",
      { role: ROLE.optional() },
      async (args) => answer("keys.list", await host.read("keys.list", args)),
    ),
    tool(
      "revoke",
      "Отозвать пропуск или непринятое приглашение по номеру: отметка у gate, соединения с этим номером закрыты на всех машинах сразу. Пропуска, выданные отозванным, живут — смотрите их по «кем» в list.",
      { kid: z.string().describe("номер пропуска") },
      async (args) => answer("keys.revoke", await host.request("keys.revoke", args)),
    ),
  ];

  const module: Module = {
    start: (h) => {
      host = h;
    },
    session: () => ({ mcpServers: { keys: createSdkMcpServer({ name: "keys", version: "1.0.0", tools: tools() }) } }),
  };
  return { module, tools };
}
