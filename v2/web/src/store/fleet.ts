// Картина флота на странице: один стор из кадров roster и roster.delta.
import type { Frame, LinkState, MachineRow, SessionRow } from "@sb/protocol";
import { create } from "zustand";

export type You = { addr: string; person: string; admin: boolean };
export type Picture = { rev: number; you: You | null; machines: Record<string, MachineRow>; sessions: Record<string, SessionRow> };

export const emptyPicture: Picture = { rev: 0, you: null, machines: {}, sessions: {} };

/** Чистый шаг: картина + кадр → картина. */
export function applyFrame(p: Picture, f: Frame): Picture {
  if (f.type === "roster") {
    const machines = Object.fromEntries((f.machines as MachineRow[]).map((m) => [m.name, m]));
    const sessions = Object.fromEntries((f.sessions as SessionRow[]).map((s) => [s.callsign, s]));
    return { rev: f.rev as number, you: f.you as You, machines, sessions };
  }
  if (f.type !== "roster.delta") return p;
  const machines = { ...p.machines }, sessions = { ...p.sessions };
  for (const m of (f.machines as MachineRow[] | undefined) ?? []) machines[m.name] = m;
  for (const name of (f.gone as string[] | undefined) ?? []) delete machines[name];
  for (const { callsign, row } of (f.sessions as Array<{ callsign: string; row: Partial<SessionRow> | null }> | undefined) ?? []) {
    if (row === null) delete sessions[callsign];
    else sessions[callsign] = { ...sessions[callsign], ...row } as SessionRow;
  }
  return { ...p, rev: f.rev as number, machines, sessions };
}

type Store = Picture & { link: LinkState; apply(f: Frame): void; setLink(s: LinkState): void };

export const useFleet = create<Store>((set) => ({
  ...emptyPicture,
  link: "connecting",
  apply: (f) => set((s) => applyFrame(s, f)),
  setLink: (link) => set({ link }),
}));

/* ===== Выборки ===== */

export const machineOfCall = (c: string) => c.slice(c.indexOf("@") + 1);
export const nameOfCall = (c: string) => c.slice(0, c.indexOf("@"));

export type InboxItem = { kind: "ask" | "done" | "failed" | "machine"; key: string; callsign?: string; machine?: string; at: number };

/** «Вам»: что ждёт этого человека. Порядок: вопросы, законченное, сбои; внутри — свежее выше. */
export function inboxOf(p: Picture): { asks: InboxItem[]; done: InboxItem[]; fails: InboxItem[] } {
  const me = p.you?.person ?? "";
  const rows = Object.values(p.sessions);
  const online = (c: string) => p.machines[machineOfCall(c)]?.online !== false;
  const by = (a: InboxItem, b: InboxItem) => b.at - a.at;
  return {
    asks: rows.filter((s) => s.ask && online(s.callsign)).map((s) => ({ kind: "ask" as const, key: "a:" + s.callsign, callsign: s.callsign, at: s.ask!.at })).sort(by),
    done: rows.filter((s) => !s.ask && s.state !== "failed" && s.unread?.includes(me)).map((s) => ({ kind: "done" as const, key: "d:" + s.callsign, callsign: s.callsign, at: s.last ?? s.since })).sort(by),
    fails: [
      ...rows.filter((s) => s.state === "failed").map((s) => ({ kind: "failed" as const, key: "f:" + s.callsign, callsign: s.callsign, at: s.last ?? s.since })),
      ...Object.values(p.machines).filter((m) => !m.online).map((m) => ({ kind: "machine" as const, key: "m:" + m.name, machine: m.name, at: m.since })),
    ].sort(by),
  };
}

/** Моя ли сессия: открыл я или сессия, которую открыл я. */
export function isMine(p: Picture, s: SessionRow, seen = new Set<string>()): boolean {
  const me = p.you;
  if (!me) return false;
  if (s.by === me.addr || s.by === me.person || s.by.endsWith(me.person)) return true;
  if (seen.has(s.callsign)) return false;
  seen.add(s.callsign);
  const parent = p.sessions[s.by];
  return parent ? isMine(p, parent, seen) : false;
}

const ORDER: Record<string, number> = { waiting: 0, failed: 1, busy: 2, starting: 2, idle: 3, stopping: 4, stopped: 5 };
export const byUrgency = (a: SessionRow, b: SessionRow) => (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9) || (b.last ?? b.since) - (a.last ?? a.since);
