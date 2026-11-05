// Запросы каталога и планов: plan, list, set, upload, fetch.
import { isBuild, isVersion, shaKey, tgzKey } from "@switchboard/release";
import type { Frame } from "@switchboard/protocol";
import type { Fetched, Listed, Plan, PlanEntry, SetResult, Upload } from "../contract.ts";
import { buildListOf, buildVersions, catalogVersions, entryOf, isModule, isRoot, scan, scriptOf, shaOf, whereOf, type Entry } from "./catalog.ts";
import { versionsOf } from "./cloudflare.ts";
import { NAME } from "./deploy.ts";
import type { Env } from "./env.ts";
import { ALWAYS, linkTo, planOf, readFleet, saveFleet, sendPlans, type Fleet } from "./fleet.ts";
import { Refusal } from "./refusal.ts";

const SHOWN = 10;
const SHA = /^[0-9a-f]{64}$/;

export async function askPlan(env: Env, f: Frame): Promise<Plan> {
  const m = /^(?:\.keeper)?@(.+)$/.exec(f.from ?? "");
  if (!m) throw new Refusal("bad_frame", "план спрашивает только машина пропуском машины");
  return planOf(env, await readFleet(env), m[1]);
}

/** Строка части в каталоге. */
async function partView(env: Env, row: Fleet, e: Entry): Promise<Listed["parts"][string] | null> {
  const where = whereOf(env, e.manifest);
  if (!where) return null;
  const script = scriptOf(env, e.manifest);
  if (!script) {
    const builds = await buildVersions(env, e.name);
    const versions = builds.length ? builds : e.versions;
    return { where, edge: versions.at(-1) ?? null, stable: row.stable[e.name] ?? null, versions: versions.slice(-SHOWN) };
  }
  const cloud = await versionsOf(env, script);
  const versions = e.manifest?.type === "web-app" ? await buildVersions(env, e.name) : cloud.tags;
  return { where, edge: versions.at(-1) ?? null, stable: cloud.live, versions: versions.slice(-SHOWN) };
}

const machineList = (row: Fleet, part?: string) =>
  Object.entries(row.plans).map(([machine, plan]) => ({ machine, plan: part ? Object.fromEntries(Object.entries(plan).filter(([p]) => p === part)) : plan })).filter((m) => !part || Object.keys(row.plans[m.machine]).length);

/** Модули сборок: в какие приложения входят, номер в выложенной сборке и новейший. */
async function modulesView(env: Env, catalog: Map<string, Entry>, parts: Listed["parts"]): Promise<NonNullable<Listed["modules"]>> {
  const roots = [...catalog.values()].filter((e) => isRoot(e.manifest) && isBuild(parts[e.name]?.stable));
  const built = new Map(await Promise.all(roots.map(async (e) => [e.name, await buildListOf(env, e.name, parts[e.name].stable!)] as const)));
  const out: NonNullable<Listed["modules"]> = {};
  for (const e of catalog.values()) {
    if (!isModule(e.manifest)) continue;
    const into = e.manifest!.into!;
    const numbers = into.flatMap((app) => {
      const v = built.get(app)?.modules.find((m) => m.name === e.name)?.version;
      return v ? [[app, v] as const] : [];
    });
    out[e.name] = { into, built: Object.fromEntries(numbers), edge: e.newest };
  }
  return out;
}

export async function list(env: Env, f: Frame): Promise<Listed> {
  const row = await readFleet(env);
  if (typeof f.part === "string") {
    const e = (await entryOf(env, f.part)) ?? (await bareEntry(env, f.part));
    const view = e && (await partView(env, row, e));
    return { parts: view ? { [f.part]: view } : {}, machines: machineList(row, f.part), rev: row.rev };
  }
  const catalog = await scan(env);
  const known = await Promise.all([...catalog.values()].map(async (e) => [e.name, await partView(env, row, e)] as const));
  const parts = Object.fromEntries(known.filter(([, v]) => v)) as Listed["parts"];
  return { parts, modules: await modulesView(env, catalog, parts), machines: machineList(row), rev: row.rev };
}

/** Только сборки флота, в каталоге версий нет. */
async function bareEntry(env: Env, part: string): Promise<Entry | null> {
  const builds = await buildVersions(env, part);
  return builds.length ? { name: part, versions: [], newest: builds.at(-1)!, manifest: null } : null;
}

function validateSet(f: Frame): void {
  const { machine, part, pin, on, force, env: vars } = f;
  if (typeof machine !== "string" || !NAME.test(machine)) throw new Refusal("bad_frame", "machine — имя машины");
  if (typeof part !== "string" || !NAME.test(part)) throw new Refusal("bad_frame", "part — имя части машины");
  if (pin !== undefined && pin !== null && !isVersion(pin) && !isBuild(pin)) throw new Refusal("bad_version", "pin — три числа или null");
  if (vars !== undefined && (typeof vars !== "object" || vars === null || Object.values(vars).some((x) => typeof x !== "string"))) throw new Refusal("bad_frame", "env — строки");
  if (part === "keeper" && (on !== undefined || force !== undefined || vars !== undefined)) throw new Refusal("bad_frame", "у keeper — только pin");
}

/** Запись плана после правки. Всё обычное в ней не хранится: за stable, включена. */
function edited(entry: PlanEntry, f: Frame): PlanEntry {
  const next = { ...entry };
  if (f.pin === null) delete next.pin;
  else if (typeof f.pin === "string") next.pin = f.pin;
  if (f.on === true) {
    delete next.on;
    delete next.force;
  } else if (f.on === false) next.on = false;
  if (f.force === true) next.force = true;
  else if (f.force === false) delete next.force;
  if (f.env) {
    if (Object.keys(f.env).length) next.env = f.env as Record<string, string>;
    else delete next.env;
  }
  return next;
}

const sameEntry = (a: PlanEntry | undefined, b: PlanEntry | undefined) => JSON.stringify(a) === JSON.stringify(b);

export async function setPlan(env: Env, f: Frame): Promise<SetResult> {
  validateSet(f);
  const machine = f.machine as string;
  const part = f.part as string;
  const e = await entryOf(env, part);
  if (e && whereOf(env, e.manifest) !== "machine") throw new Refusal("bad_frame", "part — имя части машины");
  const row = await readFleet(env);
  const plan = { ...row.plans[machine] };
  if (f.remove === true) {
    if (!plan[part]) throw new Refusal("no_part", `${part} нет в плане ${machine}`);
    delete plan[part];
  } else {
    if (typeof f.pin === "string" && !(await shaOf(env, part, f.pin))) throw new Refusal("no_release", `у ${part} нет версии ${f.pin}`);
    const next = edited(plan[part] ?? {}, f);
    if (!next.pin && !row.stable[part]) throw new Refusal("no_release", `у ${part} нет stable — закрепи версию`);
    // keeper и host есть на машине и без записи: пустая запись у них не нужна
    if (ALWAYS.includes(part) && !Object.keys(next).length) delete plan[part];
    else plan[part] = next;
  }
  if (sameEntry(plan[part], row.plans[machine]?.[part])) return { machine, rev: row.rev };
  const plans = { ...row.plans, [machine]: plan };
  if (!Object.keys(plan).length) delete plans[machine];
  const saved = await saveFleet(env, row, { stable: row.stable, plans });
  await sendPlans(env, saved, [machine]);
  return { machine, rev: saved.rev };
}

export async function uploadLinks(env: Env, f: Frame): Promise<Upload> {
  const { part, version, sha256 } = f;
  if (typeof part !== "string" || !NAME.test(part)) throw new Refusal("bad_frame", "part — имя части");
  if (!isVersion(version)) throw new Refusal("bad_version", "версия — три числа");
  if (sha256 !== undefined && (typeof sha256 !== "string" || !SHA.test(sha256))) throw new Refusal("bad_frame", "sha256 — хэш архива, 64 знака hex");
  const held = await shaOf(env, part, version);
  if (held && held === sha256) return { same: true };
  if (held) throw new Refusal("version_exists", `${part} ${version} уже загружена с другим хэшем — подними номер`);
  return { tgz: await linkTo(env, "PUT", tgzKey(part, version)), sha256: await linkTo(env, "PUT", shaKey(part, version)) };
}

export async function fetchLink(env: Env, f: Frame): Promise<Fetched> {
  const { part, version } = f;
  if (typeof part !== "string" || !NAME.test(part)) throw new Refusal("bad_frame", "part — имя модуля");
  if (version !== undefined && !isVersion(version)) throw new Refusal("bad_version", "версия каталога — три числа, без «+»");
  const v = (version as string | undefined) ?? (await catalogVersions(env, part)).at(-1);
  if (!v) throw new Refusal("no_release", `у ${part} нет версии в каталоге`);
  if (!(await shaOf(env, part, v))) throw new Refusal("no_release", `у ${part} нет версии ${v}`);
  return { version: v, url: await linkTo(env, "GET", tgzKey(part, v)) };
}
