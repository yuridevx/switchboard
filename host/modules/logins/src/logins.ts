// Снесено: вход контракта отказывает словом.
import { refuse } from "@switchboard/host";
import type { Module } from "@switchboard/host";

export type Window = { utilization: number; resetsAt: number; at: number; src: string };
export type Account = { login: "ok" | "none" | "pending"; email?: string; plan?: string; checked?: number; limits: Record<string, Window> };
export type Accounts = Record<string, Account>;
export type Machine = { accounts: Accounts; slots: Record<string, string[]> };

const gone = () => {
  throw refuse("demolished", "снесено");
};

export function make(): Module {
  return { requests: { "machine.accounts": gone, "machine.login": gone, "machine.login_code": gone, "machine.account_remove": gone, "slot.set": gone, "slot.swap": gone, "session.slot": gone }, fields: { slot: () => undefined, account: () => undefined }, opening: gone };
}
