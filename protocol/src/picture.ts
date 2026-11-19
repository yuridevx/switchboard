// Картина флота из кадров соединения page: один разбор кадров roster и roster.delta — для страницы и для обвязки живых проверок.
import type { Frame } from "./frame.ts";
import type { MachineRow } from "./contracts/fleet.ts";
import type { SessionRow } from "./contracts/session.ts";

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
    else sessions[callsign] = row as SessionRow; // строка идёт целиком и заменяет прежнюю
  }
  return { ...p, rev: f.rev as number, machines, sessions };
}
