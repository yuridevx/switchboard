// releases.deploy: stable на версию. Часть машины — строка флота и планы; часть Cloudflare — выкладка версии; модуль и корень сборки — новая сборка.
import { isBuild, isVersion } from "@switchboard/release";
import type { Frame } from "@switchboard/protocol";
import type { Deployed } from "../contract.ts";
import { buildAndShip } from "./builds.ts";
import { buildVersions, catalogVersions, isModule, isRoot, manifestAt, scan, scriptOf, shaOf, type Entry } from "./catalog.ts";
import { deployVersion, versionsOf } from "./cloudflare.ts";
import type { Env } from "./env.ts";
import { ALWAYS, deployed, followers, machinesOf, readFleet, saveFleet, sendPlans, type Fleet } from "./fleet.ts";
import { Refusal } from "./refusal.ts";

export const NAME = /^[a-z0-9][a-z0-9-]*$/;
const areNames = (x: unknown) => Array.isArray(x) && x.every((n) => typeof n === "string" && NAME.test(n));
const arrow = (part: string, from: string | null, to: string) => `${part} ${from ?? "—"} → ${to}`;

function validate(f: Frame): void {
  const { part, version, latest, without, check_with } = f;
  if (typeof part !== "string" || (part !== "*" && !NAME.test(part))) throw new Refusal("bad_frame", "part — имя части или *");
  if (version !== undefined && version !== null && !isVersion(version) && !isBuild(version)) throw new Refusal("bad_version", "версия — три числа, сборка «+n» или null — снять модуль");
  if (part === "*" && version !== undefined) throw new Refusal("bad_frame", "у * версии нет: каждая часть — на свою edge");
  if (!latest && (without !== undefined || check_with !== undefined)) throw new Refusal("bad_frame", "without и check_with — только вместе с latest: true");
  if (without !== undefined && !areNames(without)) throw new Refusal("bad_frame", "without — список имён");
  if (check_with !== undefined && !areNames(check_with)) throw new Refusal("bad_frame", "check_with — список имён");
}

/** Версия части машины: сборки флота, иначе каталог. */
async function machineEdge(env: Env, part: string): Promise<string | undefined> {
  return (await buildVersions(env, part)).at(-1) ?? (await catalogVersions(env, part)).at(-1);
}

/** Выложить версию Worker'а: только если выложена другая. */
async function shipScript(env: Env, f: Frame, part: string, script: string, version?: string): Promise<{ from: string | null; to: string }> {
  const v = await versionsOf(env, script);
  const to = version ?? v.tags.at(-1);
  if (!to || !v.idOf.has(to)) throw new Refusal("no_release", version ? `у ${part} нет версии ${version}` : `у ${part} нет версии с меткой`);
  if (v.live !== to) {
    await deployVersion(env, script, v.idOf.get(to)!);
    await deployed(env, f.from, arrow(part, v.live, to));
  }
  return { from: v.live, to };
}

/** Stable частей машины: одна правка, один план на машину. */
async function moveStable(env: Env, f: Frame, row: Fleet, moves: Array<{ part: string; to: string }>): Promise<Deployed["parts"]> {
  const changed = moves.filter((m) => row.stable[m.part] !== m.to);
  const parts = Object.fromEntries(moves.map((m) => [m.part, { from: row.stable[m.part] ?? null, to: m.to }]));
  if (!changed.length) return parts;
  const machines = await machinesOf(env);
  const next = await saveFleet(env, row, { stable: { ...row.stable, ...Object.fromEntries(changed.map((m) => [m.part, m.to])) }, plans: row.plans });
  for (const m of changed) await deployed(env, f.from, arrow(m.part, row.stable[m.part] ?? null, m.to));
  await sendPlans(env, next, [...new Set(changed.flatMap((m) => followers(next, machines, m.part)))]);
  return parts;
}

/** «*»: части Cloudflare по имени, relay последним, затем части машины на edge. */
async function deployAll(env: Env, f: Frame): Promise<Deployed> {
  const catalog = await scan(env);
  const row = await readFleet(env);
  const scripts = [...catalog.values()].flatMap((e) => {
    const script = scriptOf(env, e.manifest);
    return script ? [{ part: e.name, script }] : [];
  });
  scripts.sort((a, b) => Number(a.part === "relay") - Number(b.part === "relay") || (a.part < b.part ? -1 : 1));
  const cloud: Deployed["parts"] = {};
  for (const { part, script } of scripts) cloud[part] = await shipScript(env, f, part, script);
  const edges = await Promise.all(ALWAYS.map(async (part) => ({ part, to: await machineEdge(env, part) })));
  const machine = await moveStable(env, f, row, edges.flatMap((e) => (e.to ? [{ part: e.part, to: e.to }] : [])));
  return { parts: { ...machine, ...cloud } };
}

/** Часть машины на версию: готова — stable, планы тем, кто за ней следует. */
async function deployMachine(env: Env, f: Frame, part: string, version?: string): Promise<Deployed> {
  const to = version ?? (await machineEdge(env, part));
  if (!to) throw new Refusal("no_release", `у ${part} нет версии`);
  if (!(await shaOf(env, part, to))) throw new Refusal("no_release", `у ${part} нет версии ${to}`);
  return { parts: await moveStable(env, f, await readFleet(env), [{ part, to }]) };
}

/** Что значит запрос для имени из каталога. */
async function deployNamed(env: Env, f: Frame, part: string, entry: Entry | undefined, catalog: Map<string, Entry>): Promise<Deployed> {
  const m = entry?.manifest ?? null;
  const version = f.version as string | null | undefined;
  const latest = f.latest === true;
  if (latest && (version !== undefined || (!isRoot(m) && !isModule(m)))) throw new Refusal("bad_frame", "latest: true — только у корня сборки или модуля сборки и без version");
  if (version === null && !isModule(m)) throw new Refusal("bad_frame", `${part} — не модуль сборки: снимать нечего`);
  if (isModule(m)) {
    if (typeof version === "string" && !isVersion(version)) throw new Refusal("bad_version", `${part} — модуль: версия каталога, без «+»`);
    return buildAndShip(env, f, catalog, { kind: "module", name: part, version, latest });
  }
  // корень с версией каталога — сборка с этим ядром; прежний архив без манифеста и сборка «+n» — откат прямо на неё
  if (isRoot(m) && (latest || (isVersion(version) && (await manifestAt(env, part, version))))) return buildAndShip(env, f, catalog, { kind: "root", name: part, version: version ?? undefined, latest });
  const script = scriptOf(env, m);
  if (script) return { parts: { [part]: await shipScript(env, f, part, script, version ?? undefined) } };
  return deployMachine(env, f, part, version ?? undefined);
}

export async function deploy(env: Env, f: Frame): Promise<Deployed> {
  validate(f);
  if (f.part === "*") return deployAll(env, f);
  const catalog = await scan(env);
  return deployNamed(env, f, f.part as string, catalog.get(f.part as string), catalog);
}
