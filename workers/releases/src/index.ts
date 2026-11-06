// Worker releases: вход кадра по привязке и POST с пропуском, разбор запросов, отказ словом.
import { WorkerEntrypoint } from "cloudflare:workers";
import { entrance } from "@switchboard/gate";
import { accepts, type Frame } from "@switchboard/protocol";
import { CONTRACT, type Listed, type PlanEntry } from "../contract.ts";
import { catalog, isBuild, isVersion, NAME, type Catalog, type Part } from "./catalog.ts";
import { deploy } from "./deploy.ts";
import { line, refuse, Refusal, type Env } from "./env.ts";
import { EVERYWHERE, planOf, readRow, sendPlans, writeRow, type Row } from "./fleet.ts";

const SHOWN = 10;
const SHA = /^[0-9a-f]{64}$/;

type Asked = { env: Env; cat: Catalog; row: Row; f: Frame };

function plan({ cat, row, f }: Asked) {
  const machine = /^(?:\.keeper)?@(.+)$/.exec(String(f.from))?.[1];
  return machine ? planOf(cat, row, machine) : refuse("bad_frame", "план спрашивает машина или её keeper");
}

async function rowOf(cat: Catalog, p: Part) {
  const stable = await cat.stableOf(p);
  const versions = p.kind !== "cloud" ? await cat.onMachine(p) : p.root ? await cat.builds(p.name) : (await cat.cloud(p.script!)).tags;
  return { where: p.kind as "machine" | "cloud", edge: versions.at(-1) ?? null, stable, versions: versions.slice(-SHOWN) };
}

async function modulesOf(cat: Catalog, parts: Part[]) {
  const modules: NonNullable<Listed["modules"]> = {};
  for (const p of parts.filter((x) => x.kind === "module")) {
    const into = p.manifest!.into!;
    const built = await Promise.all(into.map(async (app) => [app, (await cat.deployed(app))?.modules.find((m) => m.name === p.name)?.version]));
    modules[p.name] = { into, built: Object.fromEntries(built.filter(([, v]) => v)), edge: p.versions.at(-1) ?? null };
  }
  return modules;
}

async function list({ cat, row, f }: Asked): Promise<Listed> {
  const part = f.part as string | undefined;
  const parts = part ? [await cat.part(part)] : await cat.all();
  const shown = parts.filter((p) => p.kind === "machine" || p.kind === "cloud");
  const rows = await Promise.all(shown.map(async (p) => [p.name, await rowOf(cat, p)] as const));
  // часть машины без единой версии — неизвестное имя: каталог не выдумывает строк; Worker без версий — выложен мимо или ещё нет
  const known = rows.filter(([, r]) => r.where === "cloud" || r.versions.length);
  const machines = Object.entries(row.plans).map(([machine, plan]) => ({ machine, plan: part ? Object.fromEntries(Object.entries(plan).filter(([name]) => name === part)) : plan }));
  return { parts: Object.fromEntries(known), ...(!part && { modules: await modulesOf(cat, parts) }), machines, rev: row.rev };
}

async function upload({ cat, f }: Asked) {
  const { part, version, sha256 } = f;
  if (typeof part !== "string" || !NAME.test(part)) refuse("bad_frame", "part — имя части");
  if (!isVersion(version)) return refuse("bad_version", "версия — три числа");
  if (sha256 !== undefined && !SHA.test(String(sha256))) refuse("bad_frame", "sha256 — хэш архива, 64 знака hex");
  const at = cat.key(part as string, version);
  const had = await cat.sha(part as string, version);
  if (had === sha256 && had) return { same: true };
  if (had) refuse("version_exists", `${part} ${version} уже загружена с другим хэшем — подними номер`);
  return { tgz: cat.link("PUT", `${at}.tgz`), sha256: cat.link("PUT", `${at}.sha256`) };
}

async function fetchLink({ cat, f }: Asked) {
  const { part, version } = f;
  if (typeof part !== "string" || !NAME.test(part)) return refuse("bad_frame", "part — имя модуля");
  if (version !== undefined && !isVersion(version)) refuse("bad_version", "версия каталога — три числа, без «+»");
  const { versions } = await cat.part(part);
  const found = (version as string | undefined) ?? versions.at(-1);
  if (!found) return refuse("no_release", `у ${part} нет версии в каталоге`);
  if (!versions.includes(found)) refuse("no_release", `у ${part} нет версии ${found}`);
  return { version: found, url: cat.link("GET", `${cat.key(part, found)}.tgz`) };
}

/** Запись плана без значений по умолчанию; порядок полей постоянный: записи сравниваются текстом. */
function entryOf(was: PlanEntry | undefined, f: Frame): PlanEntry {
  const pin = f.pin === undefined ? was?.pin : (f.pin as string | null);
  const on = (f.on ?? was?.on) as boolean | undefined;
  // включённая часть силы не держит: следующая остановка без force — штатная
  const force = (f.force ?? (f.on === true ? undefined : was?.force)) as boolean | undefined;
  const env = (f.env ?? was?.env) as Record<string, string> | undefined;
  return { ...(pin && { pin }), ...(on === false && { on }), ...(force && { force }), ...(env && Object.keys(env).length && { env }) };
}

function validateSet(f: Frame) {
  const { machine, part, pin, on, force, env } = f;
  if (typeof machine !== "string" || !NAME.test(machine)) refuse("bad_frame", "machine — имя машины");
  if (typeof part !== "string" || !NAME.test(part)) refuse("bad_frame", "part — имя части машины");
  if (pin !== undefined && pin !== null && !isVersion(pin) && !isBuild(pin)) refuse("bad_version", "pin — три числа или null");
  if (env !== undefined && !(typeof env === "object" && env && Object.values(env).every((v) => typeof v === "string"))) refuse("bad_frame", "env — строки");
  if (part === "keeper" && [on, force, env].some((x) => x !== undefined)) refuse("bad_frame", "у keeper — только pin");
}

async function set({ env, cat, row, f }: Asked) {
  validateSet(f);
  const [machine, part] = [f.machine as string, f.part as string];
  if ((await cat.part(part)).kind !== "machine") refuse("bad_frame", "part — имя части машины");
  const everywhere = EVERYWHERE.includes(part);
  const was = row.plans[machine]?.[part];
  if (f.remove && !was) refuse("no_part", `${part} нет в плане ${machine}`);
  if (typeof f.pin === "string" && !(await cat.sha(part, f.pin))) refuse("no_release", `у ${part} нет версии ${f.pin}`);
  const entry = f.remove ? undefined : entryOf(was, f);
  if (entry && !entry.pin && !row.stable[part]) refuse("no_release", `у ${part} нет stable — закрепи версию`);
  const stored = entry && (Object.keys(entry).length || !everywhere) ? entry : undefined;
  if (JSON.stringify(stored) === JSON.stringify(was)) return { machine, rev: row.rev };
  const { [part]: _old, ...others } = row.plans[machine] ?? {};
  const own = { ...others, ...(stored && { [part]: stored }) };
  const { [machine]: _own, ...plans } = row.plans;
  const next = await writeRow(env, row, { stable: row.stable, plans: Object.keys(own).length ? { ...plans, [machine]: own } : plans });
  await sendPlans(env, cat, next, [machine]);
  return { machine, rev: next.rev };
}

const REQUESTS: Record<keyof typeof CONTRACT, (r: Asked) => unknown> = {
  "releases.plan": plan,
  "releases.list": list,
  "releases.upload": upload,
  "releases.fetch": fetchLink,
  "releases.set": set,
  "releases.deploy": ({ env, cat, row, f }) => deploy(env, cat, row, f),
};

async function answer(env: Env, f: Frame): Promise<Frame[]> {
  const from = f.from;
  if (f.type === "reply") return void line({ kind: "note", ev: "reply", from, why: "releases ответов не ждёт" }), [];
  if (!f.id) return void line({ kind: "refuse", ev: f.type, word: "bad_frame", why: "запрос без id", from }), [];
  const reply = { type: "reply", id: f.id, to: from };
  const no = (word: string, why: string, extra?: Record<string, unknown>) => {
    line({ kind: "refuse", ev: f.type, word, why, from, ...extra });
    return [{ ...reply, ok: false, error: word, why }];
  };
  const refused = accepts(f, CONTRACT);
  if (refused) return no(refused.word, refused.why);
  try {
    const row = await readRow(env);
    const result = await REQUESTS[f.type as keyof typeof CONTRACT]({ env, cat: catalog(env, row), row, f });
    return [{ ...reply, ok: true, result }];
  } catch (e) {
    if (e instanceof Refusal) return no(e.word, e.message, e.extra);
    throw e;
  }
}

export class Participant extends WorkerEntrypoint<Env> {
  frame(f: Frame): Promise<Frame[]> {
    return answer(this.env, f);
  }

  fetch(req: Request): Promise<Response> {
    return entrance(req, this.env.GATE, (f) => this.frame(f));
  }
}

export default Participant;
