// Строка флота в D1 и уведомления соседей. Правка — UPDATE … WHERE rev = прочитанная: вторая одновременная получает conflict.
import type { Frame } from "@switchboard/protocol";
import { presign, RELEASES_BUCKET } from "@switchboard/release";
import type { Plan, PlanEntry, PlanPart } from "../contract.ts";
import { archiveKey, shaOf } from "./catalog.ts";
import type { Env } from "./env.ts";
import { log, Refusal } from "./refusal.ts";

export type Fleet = { stable: Record<string, string>; plans: Record<string, Record<string, PlanEntry>>; rev: number };

export const SELF = ".releases";
/** Части, которые есть на каждой машине без записи в плане. */
export const ALWAYS = ["keeper", "host"];

export async function readFleet(env: Env): Promise<Fleet> {
  const row = await env.DB.prepare("SELECT stable, plans, rev FROM fleet WHERE one = 1").first<{ stable: string; plans: string; rev: number }>();
  if (!row) throw new Refusal("bad_frame", "в базе «Выпусков» нет строки флота — миграция не применена");
  return { stable: JSON.parse(row.stable), plans: JSON.parse(row.plans), rev: row.rev };
}

/** Записать правку поверх прочитанной rev; новая rev — в ответе. */
export async function saveFleet(env: Env, row: Fleet, change: Pick<Fleet, "stable" | "plans">): Promise<Fleet> {
  const rev = row.rev + 1;
  const r = await env.DB.prepare("UPDATE fleet SET stable = ?, plans = ?, rev = ? WHERE one = 1 AND rev = ?").bind(JSON.stringify(change.stable), JSON.stringify(change.plans), rev, row.rev).run();
  if (!r.meta.changes) throw new Refusal("conflict", `строку флота уже правили после rev ${row.rev} — повтори запрос`);
  return { ...change, rev };
}

/** Машины флота — у gate; своего списка нет. Спрашиваем до записи: без них план некому послать. */
export async function machinesOf(env: Env): Promise<string[]> {
  try {
    return (await env.GATE.list("host")).map((p) => p.name);
  } catch (e) {
    throw new Refusal("gate_unavailable", `gate не ответил на list: ${String(e)}`);
  }
}

const linkKey = (env: Env) => ({ accessKeyId: env.R2_LINK_KEY_ID, secretAccessKey: env.R2_LINK_SECRET });

/** Ссылка на объект бакета на час. */
export const linkTo = (env: Env, method: "GET" | "PUT", key: string) => presign(linkKey(env), { method, host: `${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`, path: `/${RELEASES_BUCKET}/${key}` });

/** План машины: stable раскрыт в версии. Версия без хэша в план не идёт: причина строкой. */
export async function planOf(env: Env, row: Fleet, machine: string): Promise<Plan> {
  const own = row.plans[machine] ?? {};
  const names = [...new Set([...ALWAYS, ...Object.keys(own)])];
  const parts = await Promise.all(
    names.map(async (part): Promise<PlanPart | null> => {
      const entry = own[part] ?? {};
      const version = entry.pin ?? row.stable[part];
      if (!version) return null;
      const sha256 = await shaOf(env, part, version);
      if (!sha256) {
        log({ kind: "stop", ev: "releases.plan", machine, why: `у ${part} ${version} нет хэша в R2 — часть не в плане` });
        return null;
      }
      const { on, force, env: vars } = entry;
      return { part, version, sha256, url: await linkTo(env, "GET", archiveKey(env, part, version)), ...(on === false ? { on } : {}), ...(force ? { force } : {}), ...(vars ? { env: vars } : {}) };
    }),
  );
  return { rev: row.rev, parts: parts.filter((p) => p !== null) };
}

/** Новый план — кадром keeper'ам. Сосед не взял — выкладка уже состоялась, причина строкой. */
export async function sendPlans(env: Env, row: Fleet, machines: string[]): Promise<void> {
  for (const machine of machines) {
    const to = `.keeper@${machine}`;
    try {
      const frame: Frame = { type: "releases.plan", v: 1, to, from: SELF, ...(await planOf(env, row, machine)) };
      await env.RELAY.deliver(frame);
    } catch (e) {
      log({ kind: "refuse", ev: "releases.plan", word: "offline", why: `relay.deliver → ${to}: ${String(e)}` });
    }
  }
}

/** Строка журнала флота: кто и что выложил. */
export async function deployed(env: Env, by: string | undefined, text: string): Promise<void> {
  try {
    await env.LEDGER.frame({ type: "ledger.add", v: 1, to: ".ledger", from: SELF, ev: "part.deployed", text, by });
  } catch (e) {
    log({ kind: "refuse", ev: "ledger.add", word: "offline", why: `${text}: ${String(e)}` });
  }
}

/** Машины, которые следуют за stable этой части. */
export const followers = (row: Fleet, machines: string[], part: string) => machines.filter((m) => (ALWAYS.includes(part) || row.plans[m]?.[part]) && !row.plans[m]?.[part]?.pin);
