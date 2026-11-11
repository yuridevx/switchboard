// Окружение Worker'а платформы и общие мелочи двух объектов.
import { type Frame, logger, type SessionRow } from "@sb/protocol";
import type { FleetObject } from "./fleet.ts";
import type { MachineObject } from "./machine.ts";

export interface Env {
  FLEET: DurableObjectNamespace<FleetObject>;
  MACHINE: DurableObjectNamespace<MachineObject>;
  /** секрет заведения флота (`POST /boot`) */
  BOOT?: string;
  /** предел ожидания первого сообщения соединения, мс; по умолчанию HELLO_MS */
  HELLO_MS?: string;
  /** предел ответа машины на запрос, мс; по умолчанию CALL_MS договора */
  CALL_MS?: string;
}

/** Соединение, которое не представилось за это время, закрывается. */
export const HELLO_MS = 10_000;

/** Предел ожидания `hello`: соединение без входа не висит. */
export function helloLimit(ws: WebSocket, env: Env): void {
  setTimeout(() => {
    try {
      if (cardOf(ws).role === "new") shut(ws, "hello_timeout");
    } catch {
      // соединение уже закрыто
    }
  }, Number(env.HELLO_MS) || HELLO_MS);
}

/** Проверочное слово PKCE: base64url от SHA-256. */
export async function s256(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const log = logger("platform");

export const fleetStub = (env: Env, fleet: string) => env.FLEET.get(env.FLEET.idFromName(fleet));
export const machineStub = (env: Env, fleet: string, machine: string) => env.MACHINE.get(env.MACHINE.idFromName(fleet + "/" + machine));

/** Что объект машины сообщает картине флота. */
export type RowsChange =
  | { kind: "snapshot"; build?: number; sdk?: string; os?: string; sessions: SessionRow[] }
  | { kind: "delta"; callsign: string; row: Partial<SessionRow> | null }
  | { kind: "offline" }
  | { kind: "keeper"; on: boolean };

/** Кого отключить после отзыва пропуска или смены доступа. */
export type Drop = { kids?: string[]; persons?: string[] };

/** Карточка соединения: переживает усыпление объекта. */
export type Card =
  | { role: "new"; fleet?: string; machine?: string }
  | { role: "page" | "host" | "keeper" | "watch"; kid: string; addr: string; person: string; admin: boolean; fleet: string; machine?: string };

export const cardOf = (ws: WebSocket): Card => (ws.deserializeAttachment() as Card | null) ?? { role: "new" };

export function send(ws: WebSocket, f: Frame): void {
  try {
    ws.send(JSON.stringify(f));
  } catch {
    // соединение уже закрыто — его уберёт webSocketClose
  }
}

/** Закрыть соединение словом; слово читает клиент и решает, переподключаться ли. */
export function shut(ws: WebSocket, word: string): void {
  try {
    ws.close(word === "replaced" || word === "bye" ? 1000 : 1008, word);
  } catch {
    // уже закрыто
  }
}

const ALPHA = "abcdefghijklmnopqrstuvwxyz0123456789";
export function randomText(n: number): string {
  const r = crypto.getRandomValues(new Uint8Array(n));
  let s = "";
  for (const b of r) s += ALPHA[b % ALPHA.length];
  return s;
}
