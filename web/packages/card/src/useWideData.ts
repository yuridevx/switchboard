// Данные широкой карточки на время экрана: аккаунты и слоты читают и шапка, и настройки.
import { useMachineLoad } from "@switchboard/web-ui";
import type { Acc, SlotInfo } from "./session.ts";

export type WideData = ReturnType<typeof useWideData>;

export function useWideData(machine: string) {
  const accounts = useMachineLoad<{ accounts: Record<string, Acc> }>(machine, "machine.accounts");
  const slots = useMachineLoad<{ slots: Record<string, SlotInfo> }>(machine, "machine.slots");
  return {
    accounts: accounts.data ? (accounts.data.accounts ?? {}) : null,
    reloadAccounts() {
      accounts.reload();
      slots.reload();
    },
    slots: slots.data ? (slots.data.slots ?? {}) : null,
  };
}
