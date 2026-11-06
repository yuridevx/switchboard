// Снесено: заглушка контракта клиента связи.
import type { Frame, Reply } from "@switchboard/protocol";
import type { Roster } from "../contract.ts";

export const PROTO = 1;

export type LinkState = "connecting" | "open" | "closed" | "stopped";

export type WsLike = {
  readyState: number;
  addEventListener(type: "open" | "message" | "close" | "error", fn: (ev: any) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};
export type WsCtor = new (url: string) => WsLike;

export type Sent = { ok: true } | { ok: false; error: string; bytes?: number };

export type Link = {
  readonly state: LinkState;
  readonly roster: Roster | null;
  request(f: Omit<Frame, "id"> & { id?: string }, read?: boolean): Promise<Reply>;
  send(f: Frame): Sent;
  close(code?: number, reason?: string): void;
};

export type LinkOptions = {
  url: string;
  key: string;
  hello?: () => Record<string, unknown>;
  onFrame?: (f: Frame) => void;
  onState?: (state: LinkState, why?: string, retryAt?: number) => void;
  WebSocket?: WsCtor;
  pauseMs?: number;
};

export function link(_o: LinkOptions): Link {
  throw new Error("снесено");
}
