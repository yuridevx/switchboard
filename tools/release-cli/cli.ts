#!/usr/bin/env node
// switchboard release core [--out <папка>] [--dry-run]
// switchboard release keeper [--dry-run]
// switchboard release modules [--dry-run]
// switchboard release check
//
// Собирает часть из монорепо и загружает её в каталог «Выпусков» запросом releases.upload POST пропуском программы, затем архив и .sha256
// по двум ссылкам. Не выкладывает: stable двигает releases.deploy.
//   core     ядро Host без модулей — host/<номер из host/core/module.json>.tgz, проверка host --check. Сборку Host с модулями делают «Выпуски»
//   keeper   файлы для Windows и Linux одним архивом; номер — из os/keeper/module.json
//   modules  каталог: каждый модуль монорепо, кроме ядра Host и приложений ОС (остальные загружаются и после отказа одного)
//   check    до push: код под нынешним номером и каталог; содержимое разное — называет, чей номер поднять, выход 1
// Тот же номер с тем же хэшем — пропуск; с другим — отказ «Выпусков» version_exists: подними номер.
//   --out <папка>   куда собрать папку ядра, .tgz и .sha256; по умолчанию dist/release в корне монорепо
//   --dry-run       только собрать, никуда не загружать
// Из окружения: SWITCHBOARD_RELEASES — адрес Worker'а «Выпусков» флота, SWITCHBOARD_PASS — пропуск программы (ci).
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRepo } from "@switchboard/manifest-gate";
import { entries, upload, type FetchReply, type Net, type UploadReply } from "@switchboard/release";
import { buildCore, coreFiles, coreVersion, type Exec } from "./src/core.ts";
import { buildKeeper, runGo, type GoExec } from "./src/keeper.ts";
import { packFromRepo } from "./src/module.ts";
import { runNode, runNpm } from "./src/spawn.ts";
import { verify, type Get, type Local } from "./src/verify.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Предел POST к «Выпускам»: вдвое выше самого долгого ответа (list — 4,8 с) с запасом на сеть. */
const POST_MS = 30_000;
const USAGE = "вызов: switchboard release core | keeper | modules [--out <папка>] [--dry-run] | check";

export type Fetch = (url: string, init: { method: string; body: string | Uint8Array; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

type Args = { part: "core" | "keeper" | "modules" | "check"; out: string; dryRun: boolean };

function parseArgs(argv: string[]): Args {
  const [cmd, part, ...rest] = argv;
  if (cmd !== "release" || (part !== "core" && part !== "keeper" && part !== "modules" && part !== "check")) throw new Error(USAGE);
  const args: Args = { part, out: join(root, "dist", "release"), dryRun: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--dry-run") args.dryRun = true;
    else if (rest[i] === "--out" && rest[i + 1]) args.out = resolve(rest[++i]);
    else throw new Error(`незнакомый аргумент: ${rest[i]}`);
  }
  return args;
}

/** Каталог глазами программы: запросы к «Выпускам» POST пропуском. Нет адреса или пропуска — исключение. */
function catalog(env: Record<string, string | undefined>, f: Fetch) {
  const { SWITCHBOARD_RELEASES: url, SWITCHBOARD_PASS: key } = env;
  if (!url || !key) throw new Error("нет SWITCHBOARD_RELEASES или SWITCHBOARD_PASS в окружении: адрес «Выпусков» и пропуск программы");
  let n = 0;
  const post = async <T>(frame: Record<string, unknown>): Promise<T> => {
    try {
      const res = await f(url, { method: "POST", body: JSON.stringify({ v: 1, id: `ci-${++n}`, ...frame, key }), signal: AbortSignal.timeout(POST_MS) });
      return (await res.json()) as T;
    } catch (e) {
      return { ok: false, error: `offline: ${(e as Error).name === "TimeoutError" ? `«Выпуски» не ответили за ${POST_MS / 1000} с` : String(e)}` } as T;
    }
  };
  return (part: string, version: string) => ({
    ask: (sha256: string) => post<UploadReply>({ type: "releases.upload", part, version, sha256 }),
    look: () => post<FetchReply>({ type: "releases.fetch", part, version }),
  });
}
type Catalog = ReturnType<typeof catalog>;

/** Модули монорепо, которые идут в каталог: у ядра Host и приложений ОС своя сборка. */
const catalogModules = () => loadRepo(root).filter((m) => m.type !== "os" && m.type !== "sdk-core");

/** Выход 1, если хоть один отказ. */
async function modules(cat: Catalog | null, net: Net): Promise<number> {
  const counts = { uploaded: 0, same: 0, built: 0 };
  const refused: string[] = [];
  for (const m of catalogModules()) {
    const p = packFromRepo(join(root, m.dir));
    if (!cat) {
      counts.built++;
      continue;
    }
    try {
      counts[(await upload(p.version, p.tgz, cat(p.name, p.version), net)).done]++;
    } catch (e) {
      refused.push(`${p.name} ${p.version}: ${(e as Error).message}`);
    }
  }
  for (const r of refused) console.error(r);
  console.log(`каталог: загружено ${counts.uploaded}, уже были ${counts.same}, собрано без загрузки ${counts.built}, отказов ${refused.length}`);
  return refused.length ? 1 : 0;
}

/** Сверка с каталогом: модули — весь архив, ядро Host — без lockfile: его пишет npm и он зависит от ОС. Выход 1, если чей-то номер надо поднять. */
async function check(cat: Catalog, get: Get): Promise<number> {
  const locals: Local[] = [{ name: "host", version: coreVersion(root), files: coreFiles(root) }];
  for (const m of catalogModules()) {
    const p = packFromRepo(join(root, m.dir));
    locals.push({ name: p.name, version: p.version, files: entries(p.tgz).flatMap((e) => (e.data ? [{ path: e.path, data: e.data }] : [])) });
  }
  const v = await verify(locals, (part, version) => cat(part, version).look(), get, (part, path) => part === "host" && path === "package-lock.json");
  for (const s of v.stale.sort()) console.error(`подними номер: ${s}`);
  console.log(`каталог: как в коде ${v.same.length}, новых номеров ${v.fresh.length}, поднять ${v.stale.length}`);
  return v.stale.length ? 1 : 0;
}

const exec: Exec = (cmd, args, cwd) => (cmd === "npm" ? runNpm(args, cwd) : runNode(args, cwd));

export async function main(argv: string[], env: Record<string, string | undefined>, x: Exec = exec, go: GoExec = runGo, f: Fetch = fetch as unknown as Fetch): Promise<number> {
  const a = parseArgs(argv);
  const cat = a.dryRun ? null : catalog(env, f);
  const net = f as unknown as Net;
  if (a.part === "check") return check(cat!, net);
  if (a.part === "modules") return modules(cat, net);
  let part = "keeper";
  let built: { version: string; tgz: Buffer };
  if (a.part === "core") {
    const core = await buildCore(root, a.out, x);
    console.log(`собрано ядро host ${core.version}: ${core.packages} пакетов · SDK ${core.sdk} · ${core.tgz.length} байт · sha256 ${core.sha}`);
    part = "host";
    built = core;
  } else {
    const keeper = await buildKeeper(root, go);
    console.log(`собран keeper ${keeper.version}: ${keeper.tgz.length} байт · sha256 ${keeper.sha}`);
    built = keeper;
  }
  if (!cat) {
    console.log("--dry-run: никуда не загружено");
    return 0;
  }
  const { version, tgz } = built;
  const r = await upload(version, tgz, cat(part, version), net);
  console.log(r.done === "same" ? `${part} ${version} уже загружен с тем же хэшем — пропуск` : `загружено: ${part}/${version}.tgz, .sha256`);
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`switchboard release: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
