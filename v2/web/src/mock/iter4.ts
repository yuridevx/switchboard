// Мок флота — наблюдение первого класса и находки архива в формах службы: числа Host (последнее окно и ряды),
// машины в сводке здоровья, сводка архива, запись и точка найденного слова, время замера аккаунта. Ложатся поверх iter2.ts.
import { type Frame, type HostMetrics, Refusal } from "@sb/protocol";
import type { MockCtx } from "./screens.ts";

type H = Record<string, (f: any) => unknown>;
const MIN = 60_000;

/** Числа Host машины на минуту `at`: ровные и повторимые — зависят только от имени машины и времени. */
export function hostWindow(c: Pick<MockCtx, "machines" | "sessions">, machine: string, at: number, live: boolean): HostMetrics {
  const seed = [...machine].reduce((n, ch) => n + ch.charCodeAt(0), 0);
  const k = Math.floor(at / MIN);
  const wave = (period: number, shift = 0) => (Math.sin(((k + seed + shift) / period) * Math.PI * 2) + 1) / 2;
  const sessions: Record<string, number> = {};
  if (live) {
    for (const s of Object.values(c.sessions)) if (s.callsign.endsWith("@" + machine)) sessions[s.state] = (sessions[s.state] ?? 0) + 1;
  } else {
    sessions.busy = 1 + Math.round(wave(180) * 3);
    sessions.waiting = Math.round(wave(420, 40));
    sessions.idle = 2 + Math.round(wave(900, 90) * 2);
  }
  const n = 4 + Math.round(wave(60) * 20);
  const p50 = 900 + Math.round(wave(240) * 1400);
  const crash = (k + seed) % 311 === 0 ? 1 : 0;
  return {
    at, build: c.machines[machine]?.build ?? 0, sessions, queue: Math.round(wave(75, 11) * 2),
    provider: { n, p50, p95: p50 + 1800 + Math.round(wave(33) * 2600), failed: (k + seed) % 97 === 0 ? 1 : 0, retries: (k + seed) % 53 === 0 ? 1 : 0 },
    crashes: crash, resumes: crash,
  };
}

export function iter4Handlers(c: MockCtx, base: H): H {
  const { machines, now } = c;
  const mach = (f: Frame) => String(f.to).replace(/^@/, "");
  const online = (m: string) => {
    if (!machines[m]) throw new Refusal("not_found", `машины ${m} нет`);
    if (!machines[m].online) throw new Refusal("offline", `машина ${m} не на связи`);
  };
  const minute = () => Math.floor(now() / MIN) * MIN;
  return {
    "machine.metrics": (f) => (online(mach(f)), hostWindow(c, mach(f), minute(), true)),
    // ряд по минутам за период, старые первыми; машина без связи рядов после ухода не шлёт
    "obs.series": (f) => {
      const m = c.need(machines[f.machine], "такой машины нет");
      const until = Math.min(f.until ?? now(), m.online ? now() : m.since);
      const since = Math.max(f.since ?? 0, now() - 7 * 24 * 60 * MIN);
      const limit = Math.min(f.limit ?? 1440, 10_080);
      const rows: HostMetrics[] = [];
      for (let at = Math.floor(until / MIN) * MIN - MIN; at >= since && rows.length < limit; at -= MIN) rows.push(hostWindow(c, m.name, at, false));
      return { rows: rows.reverse() };
    },
    "obs.health": (f) => {
      const r = base["obs.health"]!(f) as Record<string, unknown>;
      return { ...r, hosts: Object.values(machines).filter((m) => m.online).map((m) => ({ ...hostWindow(c, m.name, minute(), true), machine: m.name })) };
    },
    // сводка архива: всего и по машинам
    "points.stats": (f) => {
      const of = (list: typeof c.archive) => ({
        sessions: list.length, points: list.reduce((n, a) => n + a.points, 0), blocks: list.reduce((n, a) => n + a.points * 3, 0), bytes: list.reduce((n, a) => n + (a.bytes ?? 0), 0),
      });
      const mine = c.archive.filter((a) => !f.machine || a.machine === f.machine);
      const names = [...new Set(mine.map((a) => a.machine))].sort();
      return { ...of(mine), sweep: { at: now() - 5 * 60 * MIN, points: 4, blocks: 9 }, machines: names.map((m) => ({ machine: m, ...of(mine.filter((a) => a.machine === m)) })) };
    },
    // найденное слово: запись разговора, в которой оно стоит, и строка с окружением
    "points.list": (f) => {
      const r = base["points.list"]!(f) as { sessions: Array<Record<string, any>> };
      const q = String(f.q ?? "").trim().toLowerCase();
      if (!q || f.sid) return r;
      const textOf = (e: any): string => (typeof e.message?.content === "string" ? e.message.content : Array.isArray(e.message?.content) ? e.message.content.filter((b: any) => b.type === "text").map((b: any) => String(b.text)).join("\n") : "");
      return {
        ...r,
        sessions: r.sessions.map((s) => {
          const e = c.talk(s.callsign).find((x) => textOf(x).toLowerCase().includes(q));
          if (!e) return s;
          const text = textOf(e), at = text.toLowerCase().indexOf(q);
          return { ...s, hitUuid: e.uuid, hit: (at > 60 ? "…" : "") + text.slice(Math.max(0, at - 60), at + q.length + 60).replace(/\s+/g, " ") + (at + q.length + 60 < text.length ? "…" : "") };
        }),
      };
    },
    // время замера — и у аккаунта целиком: Host называет его одним числом на опрос
    "account.list": (f) => {
      const r = base["account.list"]!(f) as { accounts: Array<Record<string, any>> };
      return { accounts: r.accounts.map((a) => (a.kind === "claude" ? { ...a, at: Math.max(0, ...(a.limits ?? []).map((l: { at?: number }) => l.at ?? 0)) || now() } : a)) };
    },
  };
}
