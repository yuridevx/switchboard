// Контракт relay снесён: типы остались, входы отказывают словом «снесено».
import type { Frame, Reply } from "@switchboard/protocol";

export type { Frame, Reply } from "@switchboard/protocol";
export type LinkState = "connecting" | "open" | "closed" | "stopped";
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "error", fn: () => void): void;
  addEventListener(type: "message", fn: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", fn: (ev: { code: number; reason: string }) => void): void;
}
export type WsCtor = new (url: string) => WsLike;
export type SessionRecord = { callsign: string; state?: string | null; [field: string]: unknown };
export type RosterMachine = { machine: string; since: number; proto: number; sdk?: string; contract?: Record<string, number> };
export type Roster = { type: "roster"; machines: RosterMachine[]; sessions: SessionRecord[]; clients: string[] };
export type LinkOptions = { url: string; key: string; hello?: () => Record<string, unknown>; onFrame?: (f: Frame) => void; onState?: (state: LinkState, why?: string, retryAt?: number) => void; pingMs?: number; pauseMs?: number; maxPauseMs?: number; requestMs?: number; WebSocket?: WsCtor };
export interface Link {
  readonly state: LinkState;
  readonly roster: Roster | null;
  request(f: Frame, read?: boolean): Promise<Reply>;
  send(f: Frame): { ok: true } | { ok: false; error: "disconnected" | "too_large"; bytes?: number };
  close(code?: number, reason?: string): void;
}
export type FleetOptions = { workers: Record<string, string>; key: string; machine?: string; hello?: () => Record<string, unknown>; onFrame?: (f: Frame, machine: string) => void; onState?: (machine: string, state: LinkState, why?: string, retryAt?: number) => void; onLost?: (f: Frame, word: string) => void; requestMs?: number; pingMs?: number; pauseMs?: number; maxPauseMs?: number; WebSocket?: WsCtor; fetch?: typeof fetch };
export interface FleetClient {
  readonly state: LinkState;
  readonly roster: Roster;
  readonly addr: string | null;
  links(): ReadonlyMap<string, Link>;
  request(f: Frame, read?: boolean): Promise<Reply>;
  send(f: Frame): { ok: true } | { ok: false; error: string };
  close(code?: number, reason?: string): void;
}
const gone = (): never => {
  throw new Error("снесено");
};
export const PROTO = 0;
export const link = (_o: LinkOptions): Link => gone();
export const fleet = (_o: FleetOptions): FleetClient => gone();
export const relayWs = (_w: Record<string, string>): string => gone();
