// Данные широкой карточки на время экрана: аккаунты и слоты одним ответом, их читают и шапка, и настройки.
import type { AccountsAnswer } from "@switchboard/web-ui";
import { useMachineLoad } from "@switchboard/web-ui";

export type WideData = ReturnType<typeof useWideData>;

export function useWideData(machine: string) {
  const q = useMachineLoad<AccountsAnswer>(machine, "machine.accounts");
  return {
    accounts: q.data ? (q.data.accounts ?? {}) : null,
    reloadAccounts: q.reload,
    slots: q.data ? (q.data.slots ?? {}) : null,
    /** отказ чтения: на месте слотов — слово, а не «без слота» */
    word: q.error,
  };
}
