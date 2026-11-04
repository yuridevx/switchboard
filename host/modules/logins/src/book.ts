// Записи машины и пути её папок: раздел host-logins хранилища Host и папки accounts/, slots/.
import { join } from "node:path";
import type { Host } from "@switchboard/host";
import type { Account, Accounts } from "./limits.ts";

/** Раздел машины: аккаунты и порядок аккаунтов каждого слота. */
export type Machine = { accounts: Accounts; slots: Record<string, string[]> };

export const sec = () => Math.floor(Date.now() / 1000);

export function makeBook(host: () => Host) {
  const read = (): Machine => {
    const m = host().store<Machine>().get();
    return { accounts: m?.accounts ?? {}, slots: m?.slots ?? {} };
  };
  const write = (fn: (m: Machine) => Machine) => host().store<Machine>().update((cur) => fn({ accounts: {}, slots: {}, ...cur }));
  const accountDir = (name: string) => join(host().dataDir, "accounts", name);
  return {
    accounts: () => read().accounts,
    orders: () => read().slots,
    accountDir,
    slotDir: (slot: string) => join(host().dataDir, "slots", slot),
    /** Правка записи аккаунта; undefined — запись удалена. */
    edit(name: string, fn: (a: Account | undefined) => Account | undefined) {
      write((m) => {
        const accounts = { ...m.accounts };
        const next = fn(accounts[name]);
        if (next) accounts[name] = next;
        else delete accounts[name];
        return { ...m, accounts };
      });
    },
    /** Порядок слота; null — слота нет. */
    setOrder(slot: string, list: string[] | null) {
      write((m) => {
        const slots = { ...m.slots };
        if (list) slots[slot] = list;
        else delete slots[slot];
        return { ...m, slots };
      });
    },
    /** Окружение короткого claude с папкой аккаунта. */
    envOf: (name: string): Record<string, string> => ({ CLAUDE_CONFIG_DIR: accountDir(name) }),
  };
}

export type Book = ReturnType<typeof makeBook>;
