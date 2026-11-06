// Снесено: заглушка контракта клиента флота.
import type { Frame, Reply } from "@switchboard/protocol";
import type { Roster } from "../contract.ts";
import type { Link, LinkState, Sent, WsCtor } from "./link.ts";

export type FleetClient = {
  readonly addr: string | null;
  readonly roster: Roster;
  readonly state: LinkState;
  links(): Map<string, Link>;
  request(f: Omit<Frame, "id"> & { id?: string }, read?: boolean): Promise<Reply>;
  send(f: Frame): Sent;
  close(code?: number, reason?: string): void;
};

export type FleetOptions = {
  workers: Record<string, string>;
  key: string;
  machine?: string;
  hello?: () => Record<string, unknown>;
  onFrame?: (f: Frame) => void;
  onState?: (machine: string, state: LinkState, why?: string, retryAt?: number) => void;
  onLost?: (f: Frame, word: string) => void;
  fetch?: typeof fetch;
  WebSocket?: WsCtor;
  pauseMs?: number;
};

export const relayWs = (_workers: Record<string, string>): string => {
  throw new Error("снесено");
};

export function fleet(_o: FleetOptions): FleetClient {
  throw new Error("снесено");
}
