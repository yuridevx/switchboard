#!/usr/bin/env node
// Выпуск из монорепо: switchboard release core | keeper | modules | check. Загрузка — releases.upload пропуском программы.
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRepo } from "@switchboard/manifest-gate";
import { entries, upload, type Answer, type FetchReply, type TarFile } from "@switchboard/release";
import { buildCore, coreFiles, type Exec } from "./src/core.ts";
import { buildKeeper, type Go } from "./src/keeper.ts";
import { packFromRepo, ROOT } from "./src/module.ts";
import { run } from "./src/spawn.ts";

export type Fetch = (url: string, init: { method: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer?(): Promise<ArrayBuffer> }>;
type Env = Record<string, string | undefined>;
type Ask = <T>(type: string, body: Record<string, unknown>) => Promise<Answer<T>>;

const USAGE = "вызов: switchboard release core | keeper | modules [--out <папка>] [--dry-run] | check";
const NO_ENV = "нет SWITCHBOARD_RELEASES или SWITCHBOARD_PASS в окружении: адрес «Выпусков» и пропуск программы";
const R2_MS = 10 * 60_000;
const ASK_MS = 120_000;
const LOCK = "package-lock.json";

function parse(argv: string[]) {
  const [verb, what, ...rest] = argv;
  if (verb !== "release" || !["core", "keeper", "modules", "check"].includes(what)) throw new Error(USAGE);
  const o = { what, dry: false, out: "" };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--dry-run") o.dry = true;
    else if (rest[i] === "--out" && rest[i + 1]) o.out = rest[++i];
    else throw new Error(`незнакомый аргумент: ${rest[i]}`);
  }
  return o;
}

/** Запрос к «Выпускам» POST кадра с пропуском; сеть не ответила — отказ словом. */
const asker = (env: Env, net: Fetch): Ask => async <T>(type: string, body: Record<string, unknown>) => {
  try {
    const r = await net(env.SWITCHBOARD_RELEASES!, { method: "POST", body: JSON.stringify({ type, v: 1, id: randomUUID(), key: env.SWITCHBOARD_PASS, ...body }), signal: AbortSignal.timeout(ASK_MS) });
    return (await r.json()) as Answer<T>;
  } catch (e) {
    return { ok: false, error: `offline: ${(e as Error).name === "TimeoutError" ? `нет ответа за ${ASK_MS / 1000} с` : String(e)}` };
  }
};

type Packed = { name: string; version: string; tgz: Buffer; sha: string };

/** Модули каталога: без ядра и приложений ОС, у них своя сборка. */
const catalogDirs = () => loadRepo(ROOT).filter((m) => m.type !== "os" && m.type !== "sdk-core").map((m) => join(ROOT, m.dir));

/** Пути, которые отличаются от лежащего в каталоге архива. */
function differing(mine: TarFile[], held: Uint8Array): string[] {
  const items = entries(held).filter((e) => e.data && e.path !== LOCK);
  const old = new Map(items.map((e) => [e.path, e.data!]));
  const changed = mine.filter((f) => f.path !== LOCK && !old.get(f.path)?.equals(f.data)).map((f) => f.path);
  const names = new Set(mine.map((f) => f.path));
  return [...changed, ...[...old.keys()].filter((p) => !names.has(p))];
}

/** Лежащий архив версии или null: номер новый. */
async function heldArchive(ask: Ask, net: Fetch, name: string, version: string): Promise<Uint8Array | null> {
  const a = await ask<FetchReply>("releases.fetch", { part: name, version });
  if (!a.ok && a.error === "no_release") return null;
  if (!a.ok) throw new Error(`releases.fetch ${name} ${version}: ${a.error}`);
  const r = await net(a.result.url, { method: "GET", signal: AbortSignal.timeout(R2_MS) });
  if (!r.ok) throw new Error(`${name} ${version}: R2 ответил ${r.status}`);
  return new Uint8Array(await r.arrayBuffer!());
}

/** Сверка кода с каталогом до push: кому поднять номер. Ничего не загружает. */
async function check(ask: Ask, net: Fetch): Promise<number> {
  const count = { same: 0, fresh: 0, raise: 0 };
  const compare = async (name: string, version: string, files: TarFile[]) => {
    const held = await heldArchive(ask, net, name, version);
    if (!held) return void count.fresh++;
    const diff = differing(files, held);
    if (!diff.length) return void count.same++;
    count.raise++;
    console.error(`подними номер: ${name} ${version}: ${diff.join(", ")}`);
  };
  for (const dir of catalogDirs()) {
    const p = packFromRepo(dir);
    await compare(p.name, p.version, entries(p.tgz).flatMap((e) => (e.data ? [{ path: e.path, data: e.data }] : [])));
  }
  const core = coreFiles();
  await compare("host", core.version, core.files);
  console.log(`каталог: как в коде ${count.same}, новых номеров ${count.fresh}, поднять ${count.raise}`);
  return count.raise ? 1 : 0;
}

async function send(ask: Ask, net: Fetch, m: Packed): Promise<boolean> {
  return (await upload(ask, net as never, m)).same;
}

async function modules(ask: Ask, net: Fetch, dry: boolean): Promise<number> {
  const count = { sent: 0, had: 0, built: 0, failed: 0 };
  for (const dir of catalogDirs()) {
    let label = dir;
    try {
      const p = packFromRepo(dir);
      label = `${p.name} ${p.version}`;
      if (dry) count.built++;
      else if (await send(ask, net, p)) count.had++;
      else count.sent++;
    } catch (e) {
      count.failed++;
      console.error(`${label}: ${(e as Error).message}`);
    }
  }
  console.log(`каталог: загружено ${count.sent}, уже были ${count.had}, собрано без загрузки ${count.built}, отказов ${count.failed}`);
  return count.failed ? 1 : 0;
}

async function deliver(ask: Ask, net: Fetch, m: Packed, dry: boolean): Promise<number> {
  if (dry) {
    console.log("--dry-run: никуда не загружено");
    return 0;
  }
  console.log((await send(ask, net, m)) ? `${m.name} ${m.version} уже загружен с тем же хэшем — пропуск` : `загружено: ${m.name}/${m.version}.tgz, .sha256`);
  return 0;
}

const realExec: Exec = (cmd, args, cwd) => run(cmd, args, cwd);
const realGo: Go = (args, cwd, env) => run("go", args, cwd, { env });

export async function main(argv: string[], env: Env, exec: Exec = realExec, go: Go = realGo, net: Fetch = fetch as unknown as Fetch): Promise<number> {
  const o = parse(argv);
  if ((!o.dry || o.what === "check") && (!env.SWITCHBOARD_RELEASES || !env.SWITCHBOARD_PASS)) throw new Error(NO_ENV);
  const ask = asker(env, net);
  if (o.what === "check") return check(ask, net);
  if (o.what === "modules") return modules(ask, net, o.dry);
  if (o.what === "keeper") {
    const k = await buildKeeper(go);
    console.log(`собран keeper ${k.version}: ${k.tgz.length} байт · sha256 ${k.sha}`);
    return deliver(ask, net, k, o.dry);
  }
  const core = await buildCore(o.out || mkdtempSync(join(tmpdir(), "switchboard-core-")), exec);
  console.log(core.line);
  return deliver(ask, net, { name: "host", version: core.version, tgz: core.tgz, sha: core.sha }, o.dry);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (e: Error) => {
      console.error(`switchboard release: ${e.message}`);
      process.exit(1);
    },
  );
}

