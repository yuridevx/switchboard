// Данные широкой карточки на время экрана: аккаунты и слоты читают и шапка, и настройки.
import type { AccountsAnswer, SlotsAnswer } from "@switchboard/web-ui";
import { useMachineLoad } from "@switchboard/web-ui";

export type WideData = ReturnType<typeof useWideData>;

export function useWideData(machine: string) {
  const accounts = useMachineLoad<AccountsAnswer>(machine, "machine.accounts");
  const slots = useMachineLoad<SlotsAnswer>(machine, "machine.slots");
  return {
    accounts: accounts.data ? (accounts.data.accounts ?? {}) : null,
    reloadAccounts() {
      accounts.reload();
      slots.reload();
    },
    slots: slots.data ? (slots.data.slots ?? {}) : null,
  };
}
