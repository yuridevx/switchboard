#!/usr/bin/env node
// CLI выпуска: упаковка из монорепо и загрузка в каталог пропуском программы; check до push называет, чей номер поднять.
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRepo } from "@switchboard/manifest-gate";
import { CALL_MS } from "@switchboard/protocol";
import { differs, download, shaLine, upload, type Answer, type Net, type PackedModule } from "@switchboard/release";
import { buildCore, coreArchive, type Exec } from "./src/core.ts";
import { buildKeeper, type Go } from "./src/keeper.ts";
import { packFromRepo } from "./src/module.ts";
import { run } from "./src/spawn.ts";

export type Fetch = (url: string, init: { method: string; body?: string | Uint8Array; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer?(): Promise<ArrayBuffer> }>;

const USAGE = "вызов: switchboard release core | keeper | modules [--out <папка>] [--dry-run] | check";
const NO_ENV = "нет SWITCHBOARD_RELEASES или SWITCHBOARD_PASS в окружении: адрес «Выпусков» и пропуск программы";
const ROOT = join(import.meta.dirname, "..", "..");

function options(rest: string[]) {
  const o: { out?: string; dry: boolean } = { dry: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--dry-run") o.dry = true;
    else if (rest[i] === "--out") o.out = rest[++i];
    else throw new Error(`незнакомый аргумент: ${rest[i]}`);
  }
  return o;
}

function netOf(f: Fetch, env: Record<string, string | undefined>): Net {
  const ask = async (type: string, frame: Record<string, unknown>): Promise<Answer> => {
    const body = JSON.stringify({ type, v: 1, id: randomUUID(), key: env.SWITCHBOARD_PASS, ...frame });
    try {
      return (await (await f(env.SWITCHBOARD_RELEASES!, { method: "POST", body, signal: AbortSignal.timeout(CALL_MS) })).json()) as Answer;
    } catch (e) {
      return { ok: false, error: `offline: ${e}` };
    }
  };
  return { ask, fetch: f };
}

/** Собранное — в папку и в каталог. */
async function deliver(net: Net, m: PackedModule, o: { out?: string; dry: boolean }, what: string) {
  if (o.out) {
    mkdirSync(o.out, { recursive: true });
    writeFileSync(join(o.out, `${m.version}.tgz`), m.tgz);
    writeFileSync(join(o.out, `${m.version}.sha256`), shaLine(m.sha, m.version));
  }
  if (o.dry) return console.log("--dry-run: никуда не загружено");
  const { same } = await upload(net, m);
  console.log(same ? `${what} ${m.version} уже загружен с тем же хэшем — пропуск` : `загружено: ${m.name}/${m.version}.tgz, .sha256`);
}

const catalogued = () => loadRepo(ROOT).filter((m) => m.type !== "sdk-core" && m.type !== "os");

async function modules(net: Net, dry: boolean): Promise<number> {
  const n = { sent: 0, had: 0, built: 0, bad: 0 };
  for (const m of catalogued()) {
    try {
      const packed = packFromRepo(join(ROOT, m.dir));
      if (dry) n.built++;
      else if ((await upload(net, packed)).same) n.had++;
      else n.sent++;
    } catch (e) {
      console.error(`${m.name} ${m.version}: ${(e as Error).message}`);
      n.bad++;
    }
  }
  console.log(`каталог: загружено ${n.sent}, уже были ${n.had}, собрано без загрузки ${n.built}, отказов ${n.bad}`);
  return n.bad ? 1 : 0;
}

async function check(net: Net): Promise<number> {
  const n = { same: 0, fresh: 0, raise: 0 };
  const compare = async (m: PackedModule) => {
    const label = `${m.name} ${m.version}`;
    const got = await net.ask("releases.fetch", { part: m.name, version: m.version });
    if (!got.ok && got.error === "no_release") return void n.fresh++;
    if (!got.ok) throw new Error(`releases.fetch ${label}: ${got.error}`);
    const paths = differs(await download(net, (got.result as { url: string }).url, (why) => `${label}: ${why}`), m.tgz);
    if (!paths.length) return void n.same++;
    console.error(`подними номер: ${label}: ${paths.join(", ")}`);
    n.raise++;
  };
  for (const m of catalogued()) await compare(packFromRepo(join(ROOT, m.dir)));
  await compare(coreArchive(ROOT));
  console.log(`каталог: как в коде ${n.same}, новых номеров ${n.fresh}, поднять ${n.raise}`);
  return n.raise ? 1 : 0;
}

export async function main(argv: string[], env: Record<string, string | undefined>, exec: Exec = run, go: Go = (args, cwd, vars) => run("go", args, cwd, { env: { ...process.env, ...vars } }), f: Fetch = (url, init) => fetch(url, init as RequestInit)): Promise<number> {
  const [command, what, ...rest] = argv;
  if (command !== "release" || !["core", "keeper", "modules", "check"].includes(what)) throw new Error(USAGE);
  const o = options(rest);
  if ((!o.dry || what === "check") && !(env.SWITCHBOARD_RELEASES && env.SWITCHBOARD_PASS)) throw new Error(NO_ENV);
  const net = netOf(f, env);
  if (what === "modules") return modules(net, o.dry);
  if (what === "check") return check(net);
  if (what === "core") await deliver(net, await buildCore(ROOT, exec, o.out), o, "ядро host");
  else {
    const keeper = await buildKeeper(ROOT, go);
    console.log(`собран keeper ${keeper.version}: ${keeper.tgz.length} байт · sha256 ${keeper.sha}`);
    await deliver(net, keeper, o, "keeper");
  }
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).then(
    (code) => (process.exitCode = code),
    (e: Error) => {
      console.error(e.message);
      process.exitCode = 1;
    },
  );
}
