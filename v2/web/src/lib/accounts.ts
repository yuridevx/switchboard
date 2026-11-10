// Аккаунты: один аккаунт на нескольких машинах — одна строка; лимиты, пороги, ожидание сброса.
import type { Account } from "@sb/protocol";
import { hhmm } from "./time.ts";

export type Seat = { machine: string; account: Account };
export type Merged = {
  id: string; kind: Account["kind"]; email?: string; plan?: string;
  /** где этот аккаунт вошёл */
  seats: Seat[];
  /** лимиты: по каждому окну — самое свежее из известного (большее использование) */
  limits: Array<{ name: string; used: number; resets?: number }>;
  /** на всех машинах вход годен */
  ok: boolean;
  /** сколько сессий идёт на нём по всем машинам */
  sessions: number;
  /** когда снова годен, если лимит исчерпан на всех машинах */
  wait?: number;
};

export const WARN = 0.7, BAD = 0.9;
export const limitTone = (used: number): "teal" | "orange" | "red" => (used > BAD ? "red" : used > WARN ? "orange" : "teal");

/** Свести аккаунты машин по почте (у ключа — по имени). */
export function mergeAccounts(byMachine: Record<string, Account[]>): Merged[] {
  const out = new Map<string, Merged>();
  for (const [machine, list] of Object.entries(byMachine)) {
    for (const a of list) {
      const key = a.kind + ":" + (a.email ?? a.id);
      const m = out.get(key) ?? { id: a.id, kind: a.kind, email: a.email, plan: a.plan, seats: [], limits: [], ok: true, sessions: 0 };
      m.seats.push({ machine, account: a });
      m.plan ??= a.plan;
      m.ok &&= a.ok;
      m.sessions += a.sessions ?? 0;
      for (const l of a.limits ?? []) {
        const was = m.limits.find((x) => x.name === l.name);
        if (!was) m.limits.push({ ...l });
        else if (l.used > was.used) Object.assign(was, l);
      }
      out.set(key, m);
    }
  }
  for (const m of out.values()) {
    const waits = m.seats.map((s) => s.account.wait);
    if (waits.length && waits.every((w) => w !== undefined)) m.wait = Math.min(...(waits as number[]));
  }
  return [...out.values()].sort((a, b) => Number(a.kind === "key") - Number(b.kind === "key") || Number(a.ok) - Number(b.ok) || (a.email ?? a.id).localeCompare(b.email ?? b.id));
}

/** Подпись окна лимита: «46% · до 14:30». */
export const limitWord = (l: { used: number; resets?: number }) => `${Math.round(l.used * 100)}%${l.resets ? ` · до ${hhmm(l.resets)}` : ""}`;

/** Очередь auto машины: аккаунты Claude с местом, по порядку; без места — вне очереди. */
export function queueOf(list: Account[]): { queue: Account[]; out: Account[] } {
  const claude = list.filter((a) => a.kind === "claude");
  return { queue: claude.filter((a) => a.slot !== undefined).sort((a, b) => a.slot! - b.slot!), out: claude.filter((a) => a.slot === undefined) };
}

/** Вход закончился не той почтой, которую ждали. */
export const otherMail = (expected: string | undefined, got: Account): boolean => !!expected && !!got.email && got.email.toLowerCase() !== expected.toLowerCase();
