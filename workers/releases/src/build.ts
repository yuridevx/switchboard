// Сборка приложения: список модулей, проверка набора флота, архив, выкладка. Одно правило на Host и страницы, на любой запрос.
import { check, order, ownerOf } from "@switchboard/manifest-gate";
import { hostBuild, pack, sha256hex, shaLine, webBuild, type BuildList } from "@switchboard/release";
import type { Deployed } from "../contract.ts";
import { isBuild, type Catalog, type ModuleManifest, type Part } from "./catalog.ts";
import { addressing, publish } from "./cloud.ts";
import { line, refuse, type Env } from "./env.ts";
import { advance, EVERYWHERE, journal, machinesOf, moved, type Row } from "./fleet.ts";

/** Что меняется в сборках: модуль на версии, снять, всё на новейшие, корень на версии. */
export type Change = { set?: ModuleManifest; remove?: string; latest?: boolean; root?: string; without: string[] };
type Draft = { app: string; root: ModuleManifest; modules: ModuleManifest[] };

async function draftOf(cat: Catalog, parts: Part[], app: string, change: Change): Promise<Draft> {
  const part = await cat.part(app);
  const edge = (name: string) => parts.find((p) => p.name === name)?.versions.at(-1);
  const into = parts.filter((p) => p.manifest?.into?.includes(app));
  const built = await cat.deployed(app);
  const base = built?.modules ?? into.map((p) => ({ name: p.name, version: p.versions.at(-1)! }));
  const gone = new Set([...change.without, ...(change.remove ? [change.remove] : [])]);
  // новейшая версия модуля вышла из into приложения — на новейших он из сборки уходит: снять его version: null уже нельзя
  const stays = (name: string) => !gone.has(name) && (!change.latest || into.some((p) => p.name === name));
  const wanted = new Map(base.filter((m) => stays(m.name)).map((m) => [m.name, change.latest ? (edge(m.name) ?? m.version) : m.version]));
  if (change.set) wanted.set(change.set.name, change.set.version);
  const rootVersion = change.root ?? (change.latest || !built ? part.versions.at(-1)! : built.version.split("+")[0]);
  const root = (await cat.manifest(app, rootVersion))!;

  // владельцы uses, которых в сборке ещё нет, входят на новейших версиях
  const modules = new Map<string, ModuleManifest>();
  const pending = [root];
  const take = async (name: string, version: string) => {
    const m = (await cat.manifest(name, version))!;
    modules.set(name, m);
    pending.push(m);
  };
  await Promise.all([...wanted].map(([name, version]) => take(name, version)));
  while (pending.length) {
    for (const owner of Object.keys(pending.pop()!.uses).map(ownerOf)) {
      if (!modules.has(owner) && !gone.has(owner) && into.some((p) => p.name === owner)) await take(owner, edge(owner)!);
    }
  }
  return { app, root, modules: order([...modules.values()]) };
}

/** Набор флота: новые списки, выложенные сборки остальных, прочие части на новейших; приложение ОС — только из планов. Модуль в двух версиях — отказ проверки. */
async function fleetSet(cat: Catalog, row: Row, parts: Part[], drafts: Draft[]): Promise<ModuleManifest[]> {
  const set = new Map<string, ModuleManifest>();
  const add = (m: ModuleManifest) => set.set(`${m.name}@${m.version}`, m);
  const inPlan = (name: string) => EVERYWHERE.includes(name) || Object.values(row.plans).some((plan) => plan[name]);
  for (const d of drafts) [d.root, ...d.modules].forEach(add);
  for (const p of parts) {
    if (!p.manifest || p.manifest.into || drafts.some((d) => d.app === p.name)) continue;
    const built = p.root ? await cat.deployed(p.name) : null;
    if (built) {
      add((await cat.manifest(p.name, built.version.split("+")[0]))!);
      (await Promise.all(built.modules.map((m) => cat.manifest(m.name, m.version)))).forEach((m) => add(m!));
    } else if (p.manifest.type !== "os" || inPlan(p.name)) add(p.manifest);
  }
  return [...set.values()];
}

/** Следующий номер сборки: от всех сборок этого корня, откат номера не возвращает. */
async function nextBuild(cat: Catalog, app: string, root: string) {
  const taken = (await cat.builds(app)).filter((v) => isBuild(v) && v.startsWith(`${root}+`)).map((v) => Number(v.split("+")[1]));
  return `${root}+${Math.max(0, ...taken) + 1}`;
}

export async function deployBuilds(env: Env, cat: Catalog, row: Row, apps: string[], checkWith: string[], change: Change, note: string, by: unknown): Promise<Deployed> {
  const started = Date.now();
  const parts = await cat.all();
  const drafts = await Promise.all(apps.map((app) => draftOf(cat, parts, app, change)));
  const checked = await Promise.all(checkWith.map((app) => draftOf(cat, parts, app, { latest: true, without: change.without })));
  const faults = check(await fleetSet(cat, row, parts, [...drafts, ...checked]));
  if (faults.length) refuse("check_failed", faults.join("; "));

  const onMachines = drafts.some((d) => d.root.type !== "web-app");
  const machines = onMachines ? await machinesOf(env) : [];
  const address = await addressing(env);
  const result: Deployed["parts"] = {};
  for (const { app, root, modules } of drafts) {
    const owners = new Set([root, ...modules].flatMap((m) => Object.keys(m.uses).map(ownerOf)));
    const workers = parts.filter((p) => p.kind === "cloud" && owners.has(p.name)).map((p) => [p.name, address(p.script!)]);
    const version = await nextBuild(cat, app, root.version);
    const list: BuildList = { app, version, fleet: env.FLEET, modules: modules.map((m) => ({ name: m.name, version: m.version })), workers: Object.fromEntries(workers) };
    const mods = await Promise.all(modules.map(async (m) => ({ name: m.name, tgz: await cat.archive(m.name, m.version) })));
    const core = await cat.archive(app, root.version);
    const page = root.type === "web-app";
    const files = (page ? webBuild : hostBuild)(core, mods, list);
    const tgz = pack(files);
    await env.BUCKET.put(`${cat.key(app, version)}.tgz`, tgz);
    await env.BUCKET.put(`${cat.key(app, version)}.sha256`, shaLine(sha256hex(tgz), version));
    const part = await cat.part(app);
    const from = await cat.stableOf(part);
    const move = { part: app, from, to: version, note };
    result[app] = { from, to: version };
    if (page) {
      await publish(env, part.script!, files, version);
      await journal(env, moved(move), by);
    } else await advance(env, cat, row, [move], by, machines);
    line({ kind: "note", ev: "rebuild", why: `${app} ${version}: ${Date.now() - started} мс` });
  }
  return { parts: result };
}
