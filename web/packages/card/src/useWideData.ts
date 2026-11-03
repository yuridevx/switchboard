// Данные широкой карточки на время экрана: аккаунты, слоты, модели и серверы MCP; запросы шапки и настроек.
import { useEffect, useState } from "react";
import { useApp } from "@switchboard/web-core";
import { useLoad } from "@switchboard/web-ui";
import { notAsked, type Acc, type Mcp, type Model, type SlotInfo } from "./session.ts";

export type WideData = ReturnType<typeof useWideData>;

export function useWideData(callsign: string, machine: string, live: boolean, info: boolean) {
  const app = useApp();
  const accounts = useLoad(() => (app.can(machine, "machine.accounts") === true ? app.request<{ accounts: Record<string, Acc> }>("machine.accounts", { machine }) : notAsked<{ accounts: Record<string, Acc> }>()), [machine]);
  const slots = useLoad(() => (app.can(machine, "machine.slots") === true ? app.request<{ slots: Record<string, SlotInfo> }>("machine.slots", { machine }) : notAsked<{ slots: Record<string, SlotInfo> }>()), [machine]);
  const [models, setModels] = useState<Model[] | null>(null);
  const [mcp, setMcp] = useState<Mcp[] | null>(null);

  async function loadModels() {
    if (models || !live || app.can(machine, "session.call") !== true) return;
    const r = await app.request<Model[]>("session.call", { callsign, method: "supportedModels", args: [] });
    if (r.ok && Array.isArray(r.result)) setModels(r.result);
  }

  async function loadMcp() {
    if (!live || app.can(machine, "session.call") !== true) return;
    const r = await app.request<Mcp[]>("session.call", { callsign, method: "mcpServerStatus", args: [] });
    if (r.ok && Array.isArray(r.result)) setMcp(r.result);
  }

  async function toggleMcp(m: Mcp) {
    const r = await app.request("session.call", { callsign, method: "toggleMcpServer", args: [m.name, m.status === "disabled"] });
    if (!r.ok) return app.toast(`toggleMcpServer: ${r.error}`);
    setMcp(null);
    await loadMcp();
  }

  // сведения сбоку открыты, сессия жива — серверы MCP
  useEffect(() => {
    if (info && !mcp) void loadMcp();
    // список перечитывает toggleMcp; здесь — только открытие сведений и смена «жива»
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, live]);

  async function update(body: Record<string, unknown>, what: string) {
    const r = await app.request("session.update", { callsign, ...body });
    if (!r.ok) app.toast(`${callsign}: ${what} — ${r.error}`);
  }

  async function start() {
    const r = await app.request("session.start", { callsign });
    if (!r.ok) app.toast(`${callsign}: «Запустить» — ${r.error}`);
  }

  return {
    accounts: accounts.data ? (accounts.data.accounts ?? {}) : null,
    reloadAccounts() {
      accounts.reload();
      slots.reload();
    },
    slots: slots.data ? (slots.data.slots ?? {}) : null,
    reloadSlots: slots.reload,
    models,
    loadModels,
    mcp,
    toggleMcp,
    update,
    start,
  };
}
