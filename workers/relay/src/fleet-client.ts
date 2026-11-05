// Снесено: типы контракта и отказ словом.
import type { Frame, Reply } from "@switchboard/protocol";
import type { Roster } from "../contract.ts";
import type { Link, LinkState } from "./link.ts";

export type FleetClient = {
  readonly addr: string | null;
  readonly roster: Roster;
  readonly state: LinkState;
  links(): Map<string, Link>;
  request(f: Frame, read?: boolean): Promise<Reply>;
  send(f: Frame): { ok: true } | { ok: false; error: string };
  close(code?: number, reason?: string): void;
};
export const relayWs = (_workers: Record<string, string>): string => {
  throw new Error("снесено");
};
export const fleet = (_o: Record<string, unknown>): FleetClient => {
  throw new Error("снесено");
};
