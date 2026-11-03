// Данные широкой карточки на время экрана: аккаунты, слоты, модели и серверы MCP; запросы шапки и настроек.
import { useState } from "react";
import { useApp } from "@switchboard/web-core";
import { useLoad } from "@switchboard/web-ui";
import { useCard } from "./context.ts";
import { notAsked, type Acc, type Mcp, type Model, type SlotInfo } from "./session.ts";

export type WideData = ReturnType<typeof useWideData>;

export function useWideData(callsign: string, machine: string, live: boolean, info: boolean) {
  const app = useApp();
  const card = useCard();
  const accounts = useLoad(() => (app.can(machine, "machine.accounts") === true ? app.request<{ accounts: Record<string, Acc> }>("machine.accounts", { machine }) : notAsked<{ accounts: Record<string, Acc> }>()), [machine]);
  const slots = useLoad(() => (app.can(machine, "machine.slots") === true ? app.request<{ slots: Record<string, SlotInfo> }>("machine.slots", { machine }) : notAsked<{ slots: Record<string, SlotInfo> }>()), [machine]);
  const canCall = live && app.can(machine, "session.call") === true;
  /** модели читаются при первом открытии окна, серверы MCP — при первом открытии сведений; отпущенные остаются */
  const [modelsAsked, setModelsAsked] = useState(false);
  const [mcpAsked, setMcpAsked] = useState(info);
  if (info && !mcpAsked) setMcpAsked(true);
  const models = useLoad(() => (modelsAsked && canCall ? app.request<Model[]>("session.call", { callsign, method: "supportedModels", args: [] }) : notAsked<Model[]>()), [modelsAsked, canCall, callsign]);
  const mcp = useLoad(() => (mcpAsked && canCall ? app.request<Mcp[]>("session.call", { callsign, method: "mcpServerStatus", args: [] }) : notAsked<Mcp[]>()), [mcpAsked, canCall, callsign]);

  async function toggleMcp(m: Mcp) {
    const r = await app.request("session.call", { callsign, method: "toggleMcpServer", args: [m.name, m.status === "disabled"] });
    if (!r.ok) return app.toast(`toggleMcpServer: ${r.error}`);
    mcp.reload();
  }

  async function update(body: Record<string, unknown>, what: string) {
    const r = await app.request("session.update", { callsign, ...body });
    if (!r.ok) app.toast(`${callsign}: ${what} — ${r.error}`);
  }

  async function start() {
    const r = await card.control(callsign, "session.start");
    if (!r.ok) app.toast(`${callsign}: «Запустить» — ${r.error}`);
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
    update,
    start,
  };
}
