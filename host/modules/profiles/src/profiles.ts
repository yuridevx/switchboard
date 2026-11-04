// Снесено: вход контракта отказывает словом.
import { refuse } from "@switchboard/host";
import type { Module } from "@switchboard/host";

export type Git = (args: string[], o: { cwd: string; env: Record<string, string> }) => Promise<{ code: number; out: string }>;
export type RepoState = { state: "ok" | "error" | "conflict"; op?: string; files?: string[]; since?: number; error?: string; last?: string };

const gone = () => {
  throw refuse("demolished", "снесено");
};

export function make(_deps: { git?: Git } = {}): Module {
  return { requests: { "session.profile": gone, "machine.profiles": gone }, fields: { profile: () => undefined }, opening: gone, openingReads: ["profile"] };
}
