// releases.list: части с edge и stable, записанные планы машин (какие машины есть, знает gate), у ответа о всём флоте — модули сборок.
import { byVersion, isBuild, isVersion } from "@switchboard/release";
import type { Listed } from "../contract.ts";
import { type Catalog, newest, type Part } from "./catalog.ts";
import type { Env } from "./env.ts";
import { readFleet, type Fleet } from "./fleet.ts";

type Line = Listed["parts"][string];
type Cloud = Extract<Part, { where: "cloud" }>;

const lastTen = (vs: string[]) => vs.filter(isVersion).sort(byVersion).slice(-10);

const onMachine = (fleet: Fleet, name: string, vs: string[]): Line => ({ where: "machine", edge: newest(vs), stable: fleet.stable[name] ?? null, versions: lastTen(vs) });

/** Worker спрашивается у Cloudflare; у страницы история — её сборки. */
async function inCloud(cat: Catalog, name: string, part: Cloud): Promise<Line> {
  const { tags, tag } = await cat.live(part.script);
  const vs = part.app ? await cat.builds(name) : [...tags.keys()];
  return { where: "cloud", edge: newest(vs), stable: tag, versions: lastTen(vs) };
}

function plansOf(fleet: Fleet, only?: string): Listed["machines"] {
  return Object.keys(fleet.plans)
    .sort()
    .map((machine) => {
      const plan = fleet.plans[machine];
      return { machine, plan: only ? (plan[only] ? { [only]: plan[only] } : {}) : plan };
    });
}

/** Одна часть: только её папка и манифест новейшей версии, каталог целиком не обходится. */
async function listOne(cat: Catalog, fleet: Fleet, name: string): Promise<Listed> {
  const own = await cat.ready(`${name}/`);
  const top = newest(own.filter((v) => !isBuild(v)));
  const part = top ? cat.partOf(await cat.manifest(name, top)) : null;
  const line = part?.where === "cloud" ? await inCloud(cat, name, part) : onMachine(fleet, name, part?.app ? await cat.builds(name) : own);
  return { parts: { [name]: line }, machines: plansOf(fleet, name), rev: fleet.rev };
}

async function listAll(cat: Catalog, fleet: Fleet): Promise<Listed> {
  const parts = await cat.parts();
  const cloud = [...parts].filter((e): e is [string, Cloud] => e[1].where === "cloud");
  const machine = [...new Set([...parts.keys(), ...Object.keys(fleet.stable)])].filter((n) => parts.get(n)?.where !== "cloud");
  const lines = await Promise.all([
    ...machine.toSorted().map(async (n) => [n, onMachine(fleet, n, await cat.machineVersions(n))] as const),
    ...cloud.toSorted(([a], [b]) => (a < b ? -1 : 1)).map(async ([n, part]) => [n, await inCloud(cat, n, part)] as const),
  ]);
  const byPart: Listed["parts"] = Object.fromEntries(lines);
  // модули сборок: номер в выложенной сборке каждого приложения — из её списка, новейший — из каталога
  const modules: NonNullable<Listed["modules"]> = {};
  for (const [name, e] of await cat.all()) if (e.manifest?.into?.length) modules[name] = { into: e.manifest.into, built: {}, edge: e.versions.at(-1) ?? null };
  const apps = [...parts].filter(([, p]) => p.app).map(([app]) => app);
  const built = await Promise.all(
    apps.map(async (app) => {
      const build = byPart[app]?.stable ?? (await cat.currentBuild(app, fleet));
      return [app, build ? await cat.contents(app, build) : new Map<string, string>()] as const;
    }),
  );
  for (const [app, contents] of built) for (const [name, version] of contents) if (modules[name]) modules[name].built[app] = version;
  return { parts: byPart, machines: plansOf(fleet), rev: fleet.rev, modules };
}

export async function list(env: Env, cat: Catalog, part?: string): Promise<Listed> {
  const fleet = await readFleet(env);
  return part ? listOne(cat, fleet, part) : listAll(cat, fleet);
}
