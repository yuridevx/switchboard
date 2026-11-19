// Картина флота на странице: один стор из кадров roster и roster.delta. Разбор кадра — общий, из @sb/protocol.
import { applyFrame, emptyPicture, type Frame, type LinkState, type Picture, type SessionRow, type You } from "@sb/protocol";
import { create } from "zustand";

export { applyFrame, emptyPicture };
export type { Picture, You };

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

/** Ждёт ли что-то этого человека: вопрос сессии на машине со связью или законченное, которого он не читал. Лампа на пункте «Работа». */
export function waitsYou(p: Picture): boolean {
  const me = p.you?.person ?? "";
  return Object.values(p.sessions).some((s) => (s.ask && p.machines[machineOfCall(s.callsign)]?.online !== false) || (s.state !== "failed" && s.unread?.includes(me)));
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
