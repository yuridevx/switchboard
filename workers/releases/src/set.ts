// releases.set: единственная правка плана машины. Уже так — ok с прежней rev, плана нет.
import { isVersion } from "@switchboard/release";
import type { Frame } from "@switchboard/protocol";
import type { PlanEntry, SetResult } from "../contract.ts";
import { type Catalog, NAME } from "./catalog.ts";
import type { Env } from "./env.ts";
import { readFleet, writeFleet } from "./fleet.ts";
import { EVERY_MACHINE, planFrame } from "./plans.ts";
import { Refusal } from "./refusal.ts";

/** Запись части после правки кадра. Включено — по умолчанию; force — только у выключенной. */
async function changed(cat: Catalog, f: Frame, part: string, was: PlanEntry | undefined): Promise<PlanEntry> {
  const e: PlanEntry = { ...was };
  if (f.pin === null) delete e.pin;
  else if (f.pin !== undefined) {
    if (typeof f.pin !== "string" || !isVersion(f.pin)) throw new Refusal("bad_version", "pin — три числа или null");
    if (!(await cat.sha(part, f.pin))) throw new Refusal("no_release", `у ${part} нет версии ${f.pin}`);
    e.pin = f.pin;
  }
  if (typeof f.on === "boolean") e.on = f.on;
  if (f.force === true) e.force = true;
  if (f.force === false) delete e.force;
  if (f.env !== undefined) {
    if (!f.env || typeof f.env !== "object" || Object.values(f.env).some((x) => typeof x !== "string")) throw new Refusal("bad_frame", "env — строки");
    if (Object.keys(f.env).length) e.env = f.env as Record<string, string>;
    else delete e.env;
  }
  if (e.on === true) delete e.on;
  if (e.on !== false) delete e.force;
  return e;
}

export async function set(env: Env, cat: Catalog, f: Frame): Promise<{ result: SetResult; plans: Frame[] }> {
  const { machine, part } = f;
  if (typeof machine !== "string" || !NAME.test(machine)) throw new Refusal("bad_frame", "machine — имя машины");
  if (typeof part !== "string" || !NAME.test(part) || (await cat.parts()).get(part)?.where === "cloud") throw new Refusal("bad_frame", "part — имя части машины");
  if (part === "keeper" && (f.on !== undefined || f.force !== undefined || f.env !== undefined || f.remove !== undefined)) throw new Refusal("bad_frame", "у keeper — только pin");
  const fleet = await readFleet(env);
  const plan = { ...fleet.plans[machine] };
  if (f.remove === true) {
    if (!plan[part]) throw new Refusal("no_part", `${part} нет в плане ${machine}`);
    delete plan[part];
  } else {
    const entry = await changed(cat, f, part, plan[part]);
    if (!entry.pin && !fleet.stable[part]) throw new Refusal("no_release", `у ${part} нет stable — закрепи версию`);
    if (Object.keys(entry).length || !EVERY_MACHINE.includes(part)) plan[part] = entry;
    else delete plan[part];
  }
  if (JSON.stringify(plan) === JSON.stringify(fleet.plans[machine] ?? {})) return { result: { machine, rev: fleet.rev }, plans: [] };
  const { [machine]: _old, ...others } = fleet.plans;
  const next = await writeFleet(env, fleet, { plans: Object.keys(plan).length ? { ...fleet.plans, [machine]: plan } : others });
  return { result: { machine, rev: next.rev }, plans: [await planFrame(cat, next, machine)] };
}
