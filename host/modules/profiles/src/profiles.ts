import type { Module } from "@switchboard/host";
import { refuse } from "@switchboard/host";

const REQUESTS = ["session.profile","machine.profiles"];
export function make(_o?: unknown): Module {
  return { requests: Object.fromEntries(REQUESTS.map((n) => [n, () => { throw refuse("demolished", "снесено"); }])) };
}
export type Git = (args: string[], o: { cwd: string; env: Record<string, string> }) => Promise<{ code: number; out: string }>;
