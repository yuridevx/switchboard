// Новая сборка приложений: состав с заменой, проверка набора флота, архив и выкладка. Сборка — корень и модули, чей into называет приложение:
// <флот>/<приложение>/<корень>+<n>.tgz, внутри build.json — список в порядке зависимостей. Host — stable и планы машин; страница — версия её Worker'а
// со статикой, метка — номер сборки, и выкладка. Проверка: модули всех сборок, Worker'ы, выложенные приложения ОС, библиотеки каталога.
import type { Frame } from "@switchboard/protocol";
import { buildFile, pack, sha256hex, shaLine, tgzKey, webBuild, type BuildList, type TarFile } from "@switchboard/release";
import { check, order, ownerOf } from "@switchboard/manifest-gate";
import type { Deployed } from "../contract.ts";
import type { Catalog, Entry, Mod, Part } from "./catalog.ts";
import { deploy, publishStatic, urlsOf } from "./cloudflare.ts";
import type { Env } from "./env.ts";
import { readFleet, writeFleet, type Fleet } from "./fleet.ts";
import { journal, plansAfterMove } from "./plans.ts";
import { log, Refusal } from "./refusal.ts";

export type Rebuild = {
  apps: string[];
  /** что меняется: version null — модуль снят */
  change: { name: string; version: string | null };
  by: string;
  /** собираемые и проверяемые вместе приложения — на новейших номерах */
  latest?: boolean;
  /** модули, которых больше нет в собираемых сборках */
  without?: string[];
  /** приложения, которые проверяются на новейших списках, но не собираются: смена границы модулей выкладывается по частям, а проверяется как один набор */
  checkWith?: string[];
};

/** Состав на новейших номерах: набор выложенной сборки и модули приложения, от которых он теперь зависит. Чужие модули каталога с into не входят. */
async function newestContents(cat: Catalog, app: string, build: string | null, without: string[]): Promise<Map<string, string>> {
  const all = await cat.all();
  const top = (name: string) => all.get(name)?.versions.at(-1);
  const contents = await cat.contents(app, build);
  for (const name of without) contents.delete(name);
  for (const [name, version] of contents) contents.set(name, top(name) ?? version);
  const queue = [...contents.keys()];
  while (queue.length) {
    const name = queue.pop()!;
    for (const use of Object.keys((await cat.manifest(name, contents.get(name)!))?.uses ?? {})) {
      const owner = ownerOf(use);
      if (contents.has(owner) || without.includes(owner) || !all.get(owner)?.manifest?.into?.includes(app)) continue;
      contents.set(owner, top(owner)!);
      queue.push(owner);
    }
  }
  return contents;
}

async function manifestsOf(cat: Catalog, contents: Map<string, string>): Promise<Map<string, Mod>> {
  const read = await Promise.all(
    [...contents].map(async ([name, version]) => {
      const m = await cat.manifest(name, version);
      if (!m) throw new Refusal("check_failed", `у ${name} ${version} нет module.json в начале архива`);
      return [name, m] as const;
    }),
  );
  return new Map(read);
}

/** Набор проверки: модули сборок, у общего модуля — версия собираемой сборки; остальной флот — Worker'ы, библиотеки и выложенные приложения ОС. */
function setToCheck(lists: Map<string, Map<string, Mod>>, checked: string[], roots: string[], all: Map<string, Entry>, fleet: Fleet): Mod[] {
  const set = new Map<string, Mod>();
  for (const list of lists.values()) for (const [name, m] of list) if (!set.has(name) || checked.some((app) => lists.get(app)!.get(name) === m)) set.set(name, m);
  const inBuilds = new Set([...lists.values()].flatMap((l) => [...l.keys()]));
  const placed = (name: string) => !!fleet.stable[name] || Object.values(fleet.plans).some((plan) => !!plan[name]);
  for (const [name, { manifest }] of all) {
    if (!manifest || inBuilds.has(name) || manifest.into || roots.includes(name)) continue;
    if (manifest.type !== "os" || placed(name)) set.set(name, manifest);
  }
  return [...set.values()];
}

/** Адреса Worker'ов и страниц, которыми пользуются корень и модули сборки, — у Cloudflare по имени. */
async function workersOf(env: Env, mods: Mod[], parts: Map<string, Part>): Promise<Record<string, string>> {
  const owners = new Set(mods.flatMap((m) => Object.keys(m.uses ?? {}).map(ownerOf)));
  const used = [...parts].filter((e): e is [string, Extract<Part, { where: "cloud" }>] => e[1].where === "cloud" && owners.has(e[0]));
  const urls = await urlsOf(env, used.map(([, p]) => p.script));
  return Object.fromEntries(used.map(([name, p]) => [name, urls[p.script]]));
}

async function archive(env: Env, key: string): Promise<Buffer> {
  return Buffer.from(await (await env.BUCKET.get(key))!.arrayBuffer());
}

/** Файлы сборки: страница — раскладка статики, Host — папка ядра, modules/<имя>/ и список. */
async function filesOf(env: Env, cat: Catalog, part: Part, list: BuildList, rootVersion: string): Promise<TarFile[]> {
  if (part.where === "cloud") {
    const shell = await archive(env, tgzKey(list.app, rootVersion));
    const code = await Promise.all(list.modules.map(async (m) => ({ name: m.name, tgz: await archive(env, tgzKey(m.name, m.version)) })));
    return webBuild(shell, code, list);
  }
  const core = await cat.files(tgzKey(list.app, rootVersion));
  const mods = await Promise.all(list.modules.map(async (m) => (await cat.files(tgzKey(m.name, m.version))).map((f) => ({ path: `modules/${m.name}/${f.path}`, data: f.data }))));
  return [...core, ...mods.flat(), buildFile(list)];
}

export async function rebuild(env: Env, cat: Catalog, r: Rebuild): Promise<{ result: Deployed; plans: Frame[] }> {
  const { apps, change, by, latest = false, without = [], checkWith = [] } = r;
  const fleet = await readFleet(env);
  const all = await cat.all();
  const parts = await cat.parts();
  if (change.version !== null && (!(await cat.sha(change.name, change.version)) || !all.has(change.name))) throw new Refusal("no_release", `у ${change.name} нет версии ${change.version}`);
  const roots = [...parts].filter(([, p]) => p.app).map(([name]) => name);
  const checked = [...apps, ...checkWith];
  for (const app of checked) if (!roots.includes(app)) throw new Refusal("no_build", `${app} не собирается «Выпусками»: в каталоге нет его корня сборки`);
  if (without.includes(change.name) || without.some((n) => roots.includes(n))) throw new Refusal("bad_frame", "without — модули сборки, не корень и не выкладываемая часть");

  // составы всех приложений флота: собираемые — с заменой, остальные — как выложены
  const started = Date.now();
  const current = new Map<string, string | null>();
  const lists = new Map<string, Map<string, Mod>>();
  await Promise.all(
    roots.map(async (app) => {
      const build = await cat.currentBuild(app, fleet);
      current.set(app, build);
      const contents = latest && checked.includes(app) ? await newestContents(cat, app, build, without) : await cat.contents(app, build);
      if (apps.includes(app)) {
        if (change.version === null) contents.delete(change.name);
        else contents.set(change.name, change.version);
      }
      lists.set(app, await manifestsOf(cat, contents));
    }),
  );
  const listed = Date.now();
  const errors = check(setToCheck(lists, checked, roots, all, fleet));
  if (errors.length) throw new Refusal("check_failed", errors.join("; "));

  const changed = `${change.name} ${change.version ?? "снят"}${without.length ? `; сняты ${without.join(", ")}` : ""}`;
  const result: Deployed = { parts: {} };
  const onMachines: Array<[string, string]> = [];
  for (const app of apps) {
    const appStart = Date.now();
    const mods = lists.get(app)!;
    const root = mods.get(app)!;
    const part = parts.get(app)!;
    const inOrder = order([...mods.values()].filter((m) => m.name !== app));
    const taken = (await cat.machineVersions(app)).filter((v) => v.startsWith(`${root.version}+`)).map((v) => Number(v.split("+")[1]));
    const version = `${root.version}+${1 + Math.max(0, ...taken)}`;
    const list: BuildList = { app, version, fleet: env.FLEET, modules: inOrder.map((m) => ({ name: m.name, version: m.version })), workers: await workersOf(env, [...mods.values()], parts) };
    const files = await filesOf(env, cat, part, list, root.version);
    // архив сборки — под именем флота: следующая сборка начинается с его списка
    const tgz = pack(files);
    await env.BUCKET.put(cat.tgz(app, version), tgz);
    await env.BUCKET.put(cat.shaFile(app, version), shaLine(sha256hex(tgz), version));
    if (part.where === "cloud") {
      await deploy(env, part.script, await publishStatic(env, part.script, files, version));
      await journal(env, `${app} ${current.get(app) ?? "—"} → ${version} (${changed})`, by);
    } else onMachines.push([app, version]);
    result.parts[app] = { from: current.get(app) ?? null, to: version };
    log({ kind: "note", ev: "rebuild", why: `${app} ${version}: списки и проверка ${listed - started} мс, сборка и выкладка ${Date.now() - appStart} мс` });
  }
  if (!onMachines.length) return { result, plans: [] };
  const next = await writeFleet(env, fleet, { stable: { ...fleet.stable, ...Object.fromEntries(onMachines) } });
  for (const [app, version] of onMachines) await journal(env, `${app} ${fleet.stable[app] ?? "—"} → ${version} (${changed})`, by);
  return { result, plans: await plansAfterMove(env, cat, next, onMachines.map(([app]) => app)) };
}
