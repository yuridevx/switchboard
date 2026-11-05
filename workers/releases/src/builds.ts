// Сборка приложения: новый список модулей, проверка набора флота, архив под именем флота, выкладка.
import { check, order, ownerOf } from "@switchboard/manifest-gate";
import { BUILD_FILE, buildFile, byVersion, entries, isBuild, pack, sha256hex, shaLine, shaKey, tgzKey, webBuild, type BuildList, type TarFile } from "@switchboard/release";
import type { Frame } from "@switchboard/protocol";
import type { Deployed } from "../contract.ts";
import { archive, buildListOf, buildVersions, isModule, isRoot, manifestAt, scriptOf, type Entry, type Listed } from "./catalog.ts";
import { addressesOf, publishStatic, versionsOf } from "./cloudflare.ts";
import type { Env } from "./env.ts";
import { ALWAYS, deployed, followers, machinesOf, readFleet, saveFleet, sendPlans, type Fleet } from "./fleet.ts";
import { log, Refusal } from "./refusal.ts";

export type Ask = { kind: "module" | "root"; name: string; version?: string | null; latest: boolean };

type Pinned = { name: string; version: string; manifest: Listed };
/** Содержимое сборки: ядро и модули. */
type Draft = { app: string; core: Pinned; modules: Pinned[] };
type Catalog = Map<string, Entry>;

const coreOfBuild = (v: string) => v.split("+")[0];

/** Что выложено у приложения: у части машины — строка флота, у оболочки — версия Worker'а. */
async function stableOf(env: Env, row: Fleet, catalog: Catalog, app: string): Promise<string | null> {
  const script = scriptOf(env, catalog.get(app)?.manifest ?? null);
  return script ? (await versionsOf(env, script)).live : (row.stable[app] ?? null);
}

async function pinned(env: Env, name: string, version: string): Promise<Pinned> {
  const manifest = await manifestAt(env, name, version);
  if (!manifest) throw new Refusal("no_release", `у ${name} нет версии ${version}`);
  return { name, version, manifest };
}

const newestOf = (catalog: Catalog, name: string): Pinned => {
  const e = catalog.get(name)!;
  return { name, version: e.newest, manifest: e.manifest! };
};

const modulesInto = (catalog: Catalog, app: string) => [...catalog.values()].filter((e) => isModule(e.manifest) && e.manifest!.into!.includes(app));

/** Выложенное содержимое приложения; сборки нет — null. */
async function currentDraft(env: Env, app: string, stable: string | null): Promise<Draft | null> {
  if (!isBuild(stable)) return null;
  const list = await buildListOf(env, app, stable);
  const [core, modules] = await Promise.all([pinned(env, app, coreOfBuild(stable)), Promise.all(list.modules.map((m) => pinned(env, m.name, m.version)))]);
  return { app, core, modules };
}

/** Корень на новейшей версии, модули выложенной сборки на новейших и их новые зависимости. */
function newestDraft(catalog: Catalog, app: string, current: Draft | null, without: string[]): Draft {
  const into = modulesInto(catalog, app);
  const start = current ? current.modules.map((m) => m.name) : into.map((e) => e.name);
  const names = new Set(start.filter((n) => !without.includes(n) && catalog.get(n)?.manifest?.into?.includes(app)));
  const core = newestOf(catalog, app);
  const addOwners = (m: Listed) => {
    for (const ref of Object.keys(m.uses)) {
      const owner = ownerOf(ref);
      if (names.has(owner) || without.includes(owner) || !into.some((e) => e.name === owner)) continue;
      names.add(owner);
      addOwners(catalog.get(owner)!.manifest!);
    }
  };
  addOwners(core.manifest);
  for (const n of [...names]) addOwners(catalog.get(n)!.manifest!);
  return { app, core, modules: [...names].map((n) => newestOf(catalog, n)) };
}

/** Текущая сборка плюс модуль (или без него). Сборки ещё нет — ядро и все модули каталога с into. */
async function changedDraft(env: Env, catalog: Catalog, app: string, current: Draft | null, ask: Ask): Promise<Draft> {
  const base = current ?? newestDraft(catalog, app, null, []);
  const rest = base.modules.filter((m) => m.name !== ask.name);
  if (ask.version === null) return { ...base, modules: rest };
  const version = ask.version ?? catalog.get(ask.name)!.newest;
  if (!catalog.get(ask.name)!.versions.includes(version)) throw new Refusal("no_release", `у ${ask.name} нет версии ${version}`);
  return { ...base, modules: [...rest, await pinned(env, ask.name, version)] };
}

/** Манифесты набора флота: собираемые сборки, остальные приложения, Worker'ы, библиотеки, приложения ОС в планах. */
async function fleetSet(env: Env, row: Fleet, catalog: Catalog, drafts: Draft[]): Promise<Listed[]> {
  const out = new Map<string, Listed>();
  const add = (m: Pinned) => out.set(`${m.name}@${m.version}`, m.manifest);
  for (const d of drafts) [d.core, ...d.modules].forEach(add);
  const planned = new Map<string, string | undefined>(ALWAYS.map((p) => [p, row.stable[p]]));
  for (const plan of Object.values(row.plans)) for (const [part, entry] of Object.entries(plan)) planned.set(part, entry.pin ?? row.stable[part]);
  for (const e of catalog.values()) {
    const m = e.manifest;
    if (!m || isModule(m) || drafts.some((d) => d.app === e.name)) continue;
    if (isRoot(m)) {
      const current = await currentDraft(env, e.name, await stableOf(env, row, catalog, e.name));
      if (current) [current.core, ...current.modules].forEach(add);
      else add(newestOf(catalog, e.name));
    } else if (m.type === "os") {
      const version = planned.get(e.name);
      if (version) add(await pinned(env, e.name, version));
    } else add(newestOf(catalog, e.name));
  }
  return [...out.values()];
}

/** Адреса Worker'ов, которыми пользуется сборка. */
function scriptsUsed(env: Env, catalog: Catalog, d: Draft): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of [d.core, ...d.modules]) {
    for (const ref of Object.keys(m.manifest.uses)) {
      const owner = ownerOf(ref);
      const script = scriptOf(env, catalog.get(owner)?.manifest ?? null);
      if (script) found.set(owner, script);
    }
  }
  return found;
}

/** Номер новой сборки: следующий у этого ядра в своём флоте. */
async function nextNumber(env: Env, d: Draft): Promise<string> {
  const taken = (await buildVersions(env, d.app)).filter((v) => coreOfBuild(v) === d.core.version).sort(byVersion);
  return `${d.core.version}+${Number(taken.at(-1)?.split("+")[1] ?? 0) + 1}`;
}

async function archiveFiles(env: Env, d: Draft, list: BuildList): Promise<TarFile[]> {
  if (d.core.manifest.type === "web-app") {
    const modules = await Promise.all(d.modules.map(async (m) => ({ name: m.name, tgz: await archive(env, m.name, m.version) })));
    return webBuild(await archive(env, d.app, d.core.version), modules, list);
  }
  const files: TarFile[] = entries(await archive(env, d.app, d.core.version)).flatMap((e) => (e.data ? [{ path: e.path, data: e.data, mode: e.mode }] : []));
  files.push({ path: BUILD_FILE, data: Buffer.from(buildFile(list)) });
  for (const m of d.modules) {
    for (const e of entries(await archive(env, m.name, m.version))) if (e.data) files.push({ path: `modules/${m.name}/${e.path}`, data: e.data, mode: e.mode });
  }
  return files;
}

/** Положить сборку под именем флота: архив, затем хэш. */
async function store(env: Env, app: string, version: string, tgz: Buffer): Promise<void> {
  const base = `${env.FLEET}/${app}`;
  await env.BUCKET.put(tgzKey(base, version), tgz);
  await env.BUCKET.put(shaKey(base, version), shaLine(sha256hex(tgz), version));
}

const noteOf = (ask: Ask, d: Draft, without: string[]) => {
  const removed = without.length ? `; сняты ${without.join(", ")}` : "";
  if (ask.version === null) return `снят ${ask.name}`;
  const named = ask.kind === "root" ? d.core : d.modules.find((m) => m.name === ask.name);
  return `${named?.name} ${named?.version}${removed}`;
};

/** Собрать новые сборки приложений одной проверкой и выложить. */
export async function buildAndShip(env: Env, f: Frame, catalog: Catalog, ask: Ask): Promise<Deployed> {
  const without = (f.without ?? []) as string[];
  const checkWith = (f.check_with ?? []) as string[];
  if (without.some((n) => n === ask.name || isRoot(catalog.get(n)?.manifest ?? null))) throw new Refusal("bad_frame", "without — модули сборки, не корень и не выкладываемая часть");
  for (const app of checkWith) if (!isRoot(catalog.get(app)?.manifest ?? null)) throw new Refusal("no_build", `${app} не собирается «Выпусками»: в каталоге нет его корня сборки`);
  const apps = ask.kind === "root" ? [ask.name] : catalog.get(ask.name)!.manifest!.into!;
  for (const app of apps) if (!isRoot(catalog.get(app)?.manifest ?? null)) throw new Refusal("no_build", `${app} не собирается «Выпусками»: в каталоге нет его корня сборки`);

  const row = await readFleet(env);
  const stable = new Map(await Promise.all(apps.map(async (app) => [app, await stableOf(env, row, catalog, app)] as const)));
  const drafts: Draft[] = await Promise.all(
    apps.map(async (app) => {
      const current = await currentDraft(env, app, stable.get(app) ?? null);
      if (ask.latest) return newestDraft(catalog, app, current, without);
      if (ask.kind === "module") return changedDraft(env, catalog, app, current, ask);
      return { ...(current ?? newestDraft(catalog, app, null, [])), core: await pinned(env, app, ask.version as string) };
    }),
  );
  const checked = await Promise.all(checkWith.map(async (app) => newestDraft(catalog, app, await currentDraft(env, app, await stableOf(env, row, catalog, app)), without)));
  const reasons = check((await fleetSet(env, row, catalog, [...drafts, ...checked])) as never);
  if (reasons.length) throw new Refusal("check_failed", reasons.join("; "));

  const needsPlans = drafts.some((d) => !scriptOf(env, d.core.manifest));
  const machines = needsPlans ? await machinesOf(env) : [];
  const parts: Deployed["parts"] = {};
  let next = row;
  for (const d of drafts) {
    const started = Date.now();
    const version = await nextNumber(env, d);
    const script = scriptOf(env, d.core.manifest);
    const list: BuildList = { app: d.app, version, fleet: env.FLEET, modules: order(d.modules.map((m) => ({ ...m.manifest, name: m.name, version: m.version }))).map((m) => ({ name: m.name, version: m.version })), workers: await addressesOf(env, scriptsUsed(env, catalog, d)) };
    const files = await archiveFiles(env, d, list);
    await store(env, d.app, version, pack(files as TarFile[]));
    const from = stable.get(d.app) ?? null;
    if (script) await publishStatic(env, script, version, files as Array<{ path: string; data: Buffer }>);
    else next = await saveFleet(env, next, { stable: { ...next.stable, [d.app]: version }, plans: next.plans });
    await deployed(env, f.from, `${d.app} ${from ?? "—"} → ${version} (${noteOf(ask, d, without)})`);
    parts[d.app] = { from, to: version };
    log({ kind: "note", ev: "rebuild", why: `${d.app} ${version}: ${Date.now() - started} мс` });
    if (!script) await sendPlans(env, next, followers(next, machines, d.app));
  }
  return { parts };
}

