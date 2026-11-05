// Строка флота в D1 (stable, планы машин, rev), план машины и кому он уходит, запись в журнал флота.
import { within, type Frame } from "@switchboard/protocol";
import type { Plan, PlanEntry, PlanPart } from "../contract.ts";
import type { Catalog } from "./catalog.ts";
import { line, refuse, type Env } from "./env.ts";

export type Row = { stable: Record<string, string>; plans: Record<string, Record<string, PlanEntry>>; rev: number };
/** Смена stable части: note — что вошло в сборку. */
export type Move = { part: string; from: string | null; to: string; note?: string };

/** Части, которые есть в плане каждой машины. */
export const EVERYWHERE = ["keeper", "host"];
const ME = ".releases";

export async function readRow(env: Env): Promise<Row> {
  const r = await env.DB.prepare("SELECT stable, plans, rev FROM fleet WHERE one = 1").first<{ stable: string; plans: string; rev: number }>();
  return { stable: JSON.parse(r!.stable), plans: JSON.parse(r!.plans), rev: r!.rev };
}

/** Правка — против прочитанной rev: вторая одновременная не находит строку. */
export async function writeRow(env: Env, row: Row, change: Pick<Row, "stable" | "plans">): Promise<Row> {
  const next = { ...change, rev: row.rev + 1 };
  const { meta } = await env.DB.prepare("UPDATE fleet SET stable = ?, plans = ?, rev = ? WHERE one = 1 AND rev = ?").bind(JSON.stringify(next.stable), JSON.stringify(next.plans), next.rev, row.rev).run();
  return meta.changes ? next : refuse("conflict", "строку флота правили одновременно: повтори");
}

export async function machinesOf(env: Env): Promise<string[]> {
  try {
    return (await within(env.GATE.list("host"), "gate не ответил на list")).map((p) => p.name);
  } catch (e) {
    return refuse("gate_unavailable", String(e));
  }
}

export async function planOf(cat: Catalog, row: Row, machine: string): Promise<Plan> {
  const own = row.plans[machine] ?? {};
  const names = [...new Set([...EVERYWHERE, ...Object.keys(own)])];
  const parts = await Promise.all(
    names.map(async (part): Promise<PlanPart | null> => {
      const { pin, ...rest } = own[part] ?? {};
      const version = pin ?? row.stable[part];
      if (!version) return null;
      const sha256 = await cat.sha(part, version);
      if (sha256) return { part, version, sha256, url: cat.link("GET", `${cat.key(part, version)}.tgz`), ...rest };
      line({ kind: "stop", ev: "releases.plan", machine, why: `у ${part} ${version} нет хэша в R2 — часть не в плане` });
      return null;
    }),
  );
  return { rev: row.rev, parts: parts.filter((p) => p !== null) };
}

export async function sendPlans(env: Env, cat: Catalog, row: Row, machines: string[]) {
  for (const machine of machines) {
    const to = `.keeper@${machine}`;
    const frame: Frame = { type: "releases.plan", v: 1, to, from: ME, ...(await planOf(cat, row, machine)) };
    await within(env.RELAY.deliver(frame), "relay не ответил").catch((e) => line({ kind: "refuse", ev: "releases.plan", word: "offline", why: `relay.deliver → ${to}: ${e}` }));
  }
}

export const journal = (env: Env, text: string, by: unknown) =>
  within(env.LEDGER.frame({ type: "ledger.add", v: 1, to: ".ledger", from: ME, ev: "part.deployed", text, by }), "журнал не ответил").catch((e) => line({ kind: "refuse", ev: "ledger.add", word: "offline", why: `${text}: ${e}` }));

export const moved = ({ part, from, to, note }: Move) => `${part} ${from ?? "—"} → ${to}${note ? ` (${note})` : ""}`;

/** Части машины на новые версии: строка флота, журнал, план тем, кто идёт за stable. Список машин спрашивается до записи: gate молчит — ничего не изменилось. */
export async function advance(env: Env, cat: Catalog, row: Row, moves: Move[], by: unknown, known?: string[]) {
  const real = moves.filter((m) => m.from !== m.to);
  if (!real.length) return;
  const machines = known ?? (await machinesOf(env));
  const next = await writeRow(env, row, { stable: { ...row.stable, ...Object.fromEntries(real.map((m) => [m.part, m.to])) }, plans: row.plans });
  for (const m of real) await journal(env, moved(m), by);
  const follows = (machine: string, part: string) => {
    const entry = next.plans[machine]?.[part];
    return (EVERYWHERE.includes(part) || entry) && !entry?.pin;
  };
  await sendPlans(env, cat, next, machines.filter((machine) => real.some((m) => follows(machine, m.part))));
}
