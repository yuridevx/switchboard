// Снесено: типы контракта и отказ словом.
import type { Frame, Reply } from "@switchboard/protocol";
import type { Roster } from "../contract.ts";

export const PROTO = 0;
export type LinkState = "connecting" | "open" | "closed" | "stopped";
export type WsLike = { readyState: number; send(data: string): void; close(code?: number, reason?: string): void; addEventListener(type: string, fn: (ev: any) => void): void };
export type WsCtor = new (url: string) => WsLike;
export type Link = {
  readonly state: LinkState;
  readonly roster: Roster | null;
  request(f: Frame, read?: boolean): Promise<Reply>;
  send(f: Frame): { ok: true } | { ok: false; error: string };
  close(code?: number, reason?: string): void;
};
export const link = (_o: Record<string, unknown>): Link => {
  throw new Error("снесено");
};
