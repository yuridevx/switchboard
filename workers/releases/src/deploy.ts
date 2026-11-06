// releases.deploy: «*», Worker, часть машины, сборка приложения.
import type { Frame } from "@switchboard/protocol";
import type { Deployed } from "../contract.ts";
import { deployBuilds } from "./build.ts";
import { isBuild, isVersion, NAME, type Catalog, type ModuleManifest, type Part } from "./catalog.ts";
import { release } from "./cloud.ts";
import { refuse, type Env } from "./env.ts";
import { advance, EVERYWHERE, journal, moved, type Move, type Row } from "./fleet.ts";

const LAST = "relay";

function validate(f: Frame) {
  const { part, version, latest, without, check_with } = f;
  if (part !== "*" && !(typeof part === "string" && NAME.test(part))) refuse("bad_frame", "part — имя части или *");
  if (version !== undefined && version !== null && !isVersion(version) && !isBuild(version)) refuse("bad_version", "версия — три числа, сборка «+n» или null — снять модуль");
  if (part === "*" && version !== undefined) refuse("bad_frame", "у * версии нет: каждая часть — на свою edge");
  if (!latest && (without !== undefined || check_with !== undefined)) refuse("bad_frame", "without и check_with — только вместе с latest: true");
  for (const [word, names] of [["without", without], ["check_with", check_with]] as const) {
    if (names !== undefined && !(Array.isArray(names) && names.every((n) => typeof n === "string" && NAME.test(n)))) refuse("bad_frame", `${word} — список имён`);
  }
}

/** Часть Cloudflare на версию с меткой; уже выложена — без перемен. */
async function deployCloud(env: Env, cat: Catalog, p: Part, version: string | undefined, by: unknown) {
  const state = await cat.cloud(p.script!);
  const to = version ?? (p.root ? (await cat.builds(p.name)).at(-1) : state.tags.at(-1));
  const id = to ? state.idOf(to) : undefined;
  if (!to || !id) return refuse("no_release", `у ${p.name} нет версии${version ? ` ${version}` : ""} с меткой`);
  if (state.live !== id) {
    await release(env, p.script!, id);
    await journal(env, moved({ part: p.name, from: state.stable, to }), by);
  }
  return { from: state.stable, to };
}

const edgeOf = async (cat: Catalog, p: Part) => (p.root ? (await cat.builds(p.name)).at(-1) : p.versions.at(-1));

async function machineMove(cat: Catalog, row: Row, p: Part, version?: string): Promise<Move> {
  const to = version ?? (await edgeOf(cat, p));
  if (!to) return refuse("no_release", `у ${p.name} нет версии в каталоге`);
  if (!(await cat.sha(p.name, to))) refuse("no_release", `у ${p.name} нет версии ${to}`);
  return { part: p.name, from: row.stable[p.name] ?? null, to };
}

async function deployAll(env: Env, cat: Catalog, row: Row, by: unknown): Promise<Deployed> {
  const parts = await cat.all();
  const onMachines = parts.filter((p) => EVERYWHERE.includes(p.name));
  const moves = await Promise.all(onMachines.map((p) => machineMove(cat, row, p)));
  const rank = (p: Part) => (p.name === LAST ? 1 : 0);
  const clouds = parts.filter((p) => p.kind === "cloud").sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : 1));
  const result: Deployed["parts"] = Object.fromEntries(moves.map((m) => [m.part, { from: m.from, to: m.to }]));
  for (const p of clouds) result[p.name] = await deployCloud(env, cat, p, undefined, by);
  await advance(env, cat, row, moves, by);
  return { parts: result };
}

async function deployModule(env: Env, cat: Catalog, row: Row, p: Part, f: Frame) {
  const without = (f.without ?? []) as string[];
  const checkWith = (f.check_with ?? []) as string[];
  for (const name of without) if ((await cat.part(name)).kind !== "module") refuse("bad_frame", "without — модули сборки");
  for (const app of [...checkWith, ...(p.manifest!.into ?? [])]) if (!(await cat.part(app)).root) refuse("no_build", `${app} — не приложение каталога`);
  const gone = without.length ? `; сняты ${without.join(", ")}` : "";
  const latest = !!f.latest;
  if (p.root) {
    const version = latest ? p.versions.at(-1)! : (f.version as string);
    return deployBuilds(env, cat, row, [p.name], checkWith, { latest, root: version, without }, `${p.name} ${version}${gone}`, f.from);
  }
  if (isBuild(f.version)) refuse("bad_version", "версия модуля — три числа");
  const into = p.manifest!.into!;
  if (f.version === null) return deployBuilds(env, cat, row, into, checkWith, { remove: p.name, without }, `снят ${p.name}`, f.from);
  const version = (f.version as string | undefined) ?? p.versions.at(-1)!;
  const set = (await cat.manifest(p.name, version)) as ModuleManifest | null;
  if (!set) return refuse("no_release", `у ${p.name} нет версии ${version}`);
  return deployBuilds(env, cat, row, into, checkWith, { set, latest, without }, `${p.name} ${version}${gone}`, f.from);
}

export async function deploy(env: Env, cat: Catalog, row: Row, f: Frame): Promise<Deployed> {
  validate(f);
  if (f.part === "*") return deployAll(env, cat, row, f.from);
  return deployOne(env, cat, row, f);
}

async function deployOne(env: Env, cat: Catalog, row: Row, f: Frame): Promise<Deployed> {
  const name = f.part as string;
  const p = await cat.part(name);
  const module = p.kind === "module";
  if (f.latest && (f.version !== undefined || !(module || p.root))) refuse("bad_frame", "latest: true — только у корня сборки или модуля сборки и без version");
  if (f.version === null && !module) refuse("bad_frame", `${name} — не модуль сборки: снимать нечего`);
  const catalogRoot = p.root && isVersion(f.version) && (await cat.manifest(name, f.version));
  if (module || f.latest || catalogRoot) return deployModule(env, cat, row, p, f);
  const version = (f.version ?? undefined) as string | undefined;
  if (p.kind === "cloud") return { parts: { [name]: await deployCloud(env, cat, p, version, f.from) } };
  const move = await machineMove(cat, row, p, version);
  await advance(env, cat, row, [move], f.from);
  return { parts: { [name]: { from: move.from, to: move.to } } };
}
