// Модуль keys: пропуска флота из разговора. Выдать и посмотреть — у gate, отозвать — на входе relay; хранить нечего.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Host, Module, Result } from "@switchboard/host";

const role = z.enum(["host", "client"]);

/** Ответ запроса — модели: значение с отступами или отказ словом с именем запроса. */
function said(type: string, r: Result) {
  if (r.ok) return { content: [{ type: "text" as const, text: JSON.stringify(r.result, null, 2) }] };
  return { content: [{ type: "text" as const, text: `${type}: ${r.error}` }], isError: true };
}

export function make() {
  let host!: Host;
  const tools = () => [
    tool(
      "invite",
      "Выдать пропуск флота одноразовым приглашением. Машина — role host и имя машины: приглашение принимает keeper install. Устройство или программа — role client, имя и почта человека: телефон и пульт принимают приглашение ссылкой с #invite=<приглашение> или в поле ввода, программа — switchboard redeem. У адреса один живой пропуск: занят — name_taken, сначала отзовите прежний.",
      { role, name: z.string().describe("имя машины, устройства или программы: A-Z a-z 0-9 _ -"), person: z.string().optional().describe("почта человека за устройством или программой; у машины нет") },
      async ({ role, name, person }) => said("keys.invite", await host.request("keys.invite", { role, name, person: person || undefined })),
    ),
    tool(
      "list",
      "Пропуска флота: номер, роль, имя, человек, адрес, состояние (wait — приглашение не принято, ok), кем выдан и когда. role — только принятые этой роли.",
      { role: role.optional() },
      async (args) => said("keys.list", await host.read("keys.list", args)),
    ),
    tool(
      "revoke",
      "Отозвать пропуск или непринятое приглашение по номеру: отметка у gate, соединения с этим номером закрыты на всех машинах сразу. Пропуска, выданные отозванным, живут — смотрите их по «кем» в list.",
      { kid: z.string().describe("номер пропуска") },
      async (args) => said("keys.revoke", await host.request("keys.revoke", args)),
    ),
  ];
  const module: Module = {
    start(h) {
      host = h;
    },
    session: () => ({ mcpServers: { keys: createSdkMcpServer({ name: "keys", version: "1.0.0", tools: tools() }) } }),
  };
  return { module, tools };
}
