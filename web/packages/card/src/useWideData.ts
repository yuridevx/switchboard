// Данные широкой карточки на время экрана: аккаунты, слоты, модели и серверы MCP; запросы шапки и настроек.
import { useState } from "react";
import { useMachineLoad, useApp } from "@switchboard/web-ui";
import { useSessionActions } from "./hooks.ts";
import type { Acc, Mcp, Model, SlotInfo } from "./session.ts";

export type WideData = ReturnType<typeof useWideData>;

export function useWideData(callsign: string, machine: string, live: boolean, info: boolean) {
  const app = useApp();
  const actions = useSessionActions(callsign);
  const accounts = useMachineLoad<{ accounts: Record<string, Acc> }>(machine, "machine.accounts");
  const slots = useMachineLoad<{ slots: Record<string, SlotInfo> }>(machine, "machine.slots");
  /** модели читаются при первом открытии окна, серверы MCP — при первом открытии сведений; отпущенные остаются */
  const [modelsAsked, setModelsAsked] = useState(false);
  const [mcpAsked, setMcpAsked] = useState(info);
  if (info && !mcpAsked) setMcpAsked(true);
  const models = useMachineLoad<Model[]>(machine, "session.call", { callsign, method: "supportedModels", args: [] }, modelsAsked && live);
  const mcp = useMachineLoad<Mcp[]>(machine, "session.call", { callsign, method: "mcpServerStatus", args: [] }, mcpAsked && live);

  async function toggleMcp(m: Mcp) {
    const r = await app.request("session.call", { callsign, method: "toggleMcpServer", args: [m.name, m.status === "disabled"] });
    if (!r.ok) return app.toast(`toggleMcpServer: ${r.error}`);
    mcp.reload();
  }

  async function reconnectMcp(m: Mcp) {
    const r = await app.request("session.call", { callsign, method: "reconnectMcpServer", args: [m.name] });
    if (!r.ok) return app.toast(`reconnectMcpServer: ${r.error}`);
    mcp.reload();
  }

  /** Вход сервера MCP: адрес страницы входа. Окно после ответа запроса браузер блокирует: страницу открывает ссылка. */
  async function loginMcp(m: Mcp): Promise<string | undefined> {
    const r = await app.request<{ authUrl?: string } | null>("session.call", { callsign, method: "mcpAuthenticate", args: [m.name] });
    if (!r.ok) return void app.toast(`mcpAuthenticate: ${r.error}`);
    if (!r.result?.authUrl) app.toast("mcpAuthenticate: ссылки нет");
    return r.result?.authUrl;
  }

  async function update(body: Record<string, unknown>, what: string) {
    const r = await app.request("session.update", { callsign, ...body });
    if (!r.ok) app.toast(`${callsign}: ${what} — ${r.error}`);
  }

  async function start() {
    const word = await actions.act("session.start");
    if (word) app.toast(`${callsign}: «Запустить» — ${word}`);
  }

  return {
    accounts: accounts.data ? (accounts.data.accounts ?? {}) : null,
    reloadAccounts() {
      accounts.reload();
      slots.reload();
    },
    slots: slots.data ? (slots.data.slots ?? {}) : null,
    models: Array.isArray(models.data) ? models.data : null,
    loadModels: () => setModelsAsked(true),
    mcp: Array.isArray(mcp.data) ? mcp.data : null,
    toggleMcp,
    reconnectMcp,
    loginMcp,
    update,
    start,
  };
}
