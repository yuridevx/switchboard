// Общее лесов ядра: стенд с уборкой после теста, модуль расхода из дизайна, чтение журнала и core.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import type { Module } from "../contract.ts";
import { FakeHolders, module, standHost } from "../stand/index.ts";
import type { FakeProc, Stand } from "../stand/index.ts";

/** Пределы контракта остановки: ступень остановки процесса и ожидание конца хода перед перезапуском. */
export const STOP_STEP = 30_000;
export const RESTART_WAIT = 6 * 3_600_000;
export const CS = "site@laptop";

export const stands: Stand[] = [];
const keepers: FakeHolders[] = [];
export const procs: FakeProc[] = [];

export async function stand(o: Parameters<typeof standHost>[0] = {}): Promise<Stand> {
  const st = await standHost(o);
  stands.push(st);
  return st;
}

export function keeper(): FakeHolders {
  const k = new FakeHolders();
  keepers.push(k);
  return k;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const st of stands.splice(0)) await st.close();
  for (const k of keepers.splice(0)) await k.close();
  for (const p of procs.splice(0)) await p.close();
});

/** Модуль расхода из дизайна: поле cost и запрос session.cost. */
export function cost(version = "1.0.0", extra: Partial<Module> = {}, provides: Record<string, number> = {}) {
  const mod: Module = {
    fields: { cost: (s) => s.store<{ usd: number; turns: number }>().get() ?? { usd: 0, turns: 0 } },
    on: {
      event(s, m) {
        if (m.type !== "result") return;
        s.store<{ usd: number; turns: number }>().update((c = { usd: 0, turns: 0 }) => ({ usd: c.usd + (m as { total_cost_usd: number }).total_cost_usd, turns: c.turns + 1 }));
      },
    },
    requests: { "session.cost": (req, { host }) => host.session(req.callsign as string)!.store().get() },
    ...extra,
  };
  return module("host-cost", mod, { version, provides });
}

export const lines = (st: Stand, ev?: string) => st.journal().filter((l) => !ev || l.ev === ev);
export const core = (st: Stand) => (JSON.parse(readFileSync(join(st.home, "store", "core.json"), "utf8")) as { sessions: Array<Record<string, unknown>> }).sessions;
