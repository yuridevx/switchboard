import type { Module } from "@switchboard/host";
import { refuse } from "@switchboard/host";

const REQUESTS = ["machine.accounts","machine.login","machine.login_code","machine.account_remove","session.slot","slot.set","slot.swap"];
export function make(_o?: unknown): Module {
  return { requests: Object.fromEntries(REQUESTS.map((n) => [n, () => { throw refuse("demolished", "снесено"); }])) };
}
