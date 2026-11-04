// План машины: что keeper должен держать, stable раскрыт в версии, ссылки на архивы на час. Уходит ответом на releases.plan и кадром при перемене.
// Машины флота — принятые пропуска роли host у gate: своего списка нет. Строки журнала флота — привязкой, не вышло — строка здесь.
import { type Frame, within } from "@switchboard/protocol";
import type { LedgerAdd } from "@switchboard/ledger";
import type { Plan, PlanPart } from "../contract.ts";
import type { Catalog } from "./catalog.ts";
import type { Env } from "./env.ts";
import type { Fleet } from "./fleet.ts";
import { log, Refusal } from "./refusal.ts";

/** Части каждой машины: без записи в плане — за stable. */
export const EVERY_MACHINE = ["keeper", "host"];

/** Версии без хэша в план не идут. */
export async function planOf(cat: Catalog, fleet: Fleet, machine: string): Promise<Plan> {
  const own = fleet.plans[machine] ?? {};
  const parts: PlanPart[] = [];
  for (const part of new Set([...EVERY_MACHINE, ...Object.keys(own)])) {
    const { pin, on, force, env } = own[part] ?? {};
    const version = pin ?? fleet.stable[part];
    if (!version) continue;
    const sha256 = await cat.sha(part, version);
    if (!sha256) {
      log({ kind: "stop", ev: "releases.plan", why: `у ${part} ${version} нет хэша в R2 — часть не в плане`, machine });
      continue;
    }
    parts.push({ part, version, sha256, url: await cat.link("GET", cat.tgz(part, version)), ...(on !== undefined ? { on } : {}), ...(force ? { force } : {}), ...(env ? { env } : {}) });
  }
  return { rev: fleet.rev, parts };
}

export async function planFrame(cat: Catalog, fleet: Fleet, machine: string): Promise<Frame> {
  return { type: "releases.plan", v: 1, to: `.keeper@${machine}`, from: ".releases", ...(await planOf(cat, fleet, machine)) } as unknown as Frame;
}

/**
 * Машины флота. Спрашивается до записи stable: записанный stable без планов повтор выкладки уже не исправит — from = to, планов нет,
 * и keeper'ы на связи остаются на старой версии. gate не ответил — отказ, строка флота не тронута.
 */
export async function fleetMachines(env: Env): Promise<string[]> {
  try {
    return (await within(env.GATE.list("host"), "gate не ответил на list")).map((p) => p.name).sort();
  } catch (e) {
    throw new Refusal("gate_unavailable", String(e));
  }
}

/** Планы машин, у которых сдвинутая часть идёт за stable: она в плане без pin или своя для каждой машины. */
export async function plansAfterMove(cat: Catalog, fleet: Fleet, machines: string[], moved: string[]): Promise<Frame[]> {
  const follows = (machine: string) => moved.some((part) => {
    const entry = fleet.plans[machine]?.[part];
    return entry ? !entry.pin : EVERY_MACHINE.includes(part);
  });
  return Promise.all(machines.filter(follows).map((m) => planFrame(cat, fleet, m)));
}

/** Планы keeper'ам — в объект машины. relay не ответил — строка журнала: keeper возьмёт план на следующем соединении. */
export async function deliver(env: Env, plans: Frame[]): Promise<void> {
  for (const f of plans) {
    try {
      const reached = await within(env.RELAY.deliver(f), "relay не ответил на deliver");
      log({ kind: "note", ev: "releases.plan", why: `план → ${String(f.to)}: ${reached ? "доставлен" : "keeper не на связи"}` });
    } catch (e) {
      log({ kind: "refuse", ev: "releases.plan", word: "offline", why: `relay.deliver → ${String(f.to)}: ${e}` });
    }
  }
}

/** Строка part.deployed журнала флота. */
export async function journal(env: Env, text: string, by: string): Promise<void> {
  const line: LedgerAdd = { type: "ledger.add", v: 1, to: ".ledger", ev: "part.deployed", text, ...(by ? { by } : {}) };
  try {
    await within(env.LEDGER.frame({ ...(line as unknown as Frame), from: ".releases" }), "журнал не ответил");
  } catch (e) {
    log({ kind: "refuse", ev: "ledger.add", word: "offline", why: `${text}: ${e}` });
  }
}
