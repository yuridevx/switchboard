#!/usr/bin/env node
// switchboard release core [--out <папка>] [--dry-run]
// switchboard release keeper [--dry-run]
// switchboard release modules [--dry-run]
//
// Собирает часть из монорепо и загружает её в каталог «Выпусков» одной функцией загрузки формата выпуска: запрос
// releases.upload POST пропуском программы, затем архив и .sha256 по двум ссылкам. Не выкладывает: stable двигает
// releases.deploy.
//   core     ядро Host без модулей — host/<номер из host/core/module.json>.tgz, проверка host --check. Сборку Host
//            с модулями делают «Выпуски»
//   keeper   файлы для Windows и Linux одним архивом; номер — из os/keeper/module.json
//   modules  каталог: каждый модуль монорепо, кроме ядра Host и приложений ОС, — <модуль>/<номер из module.json>.tgz
//            (остальные модули загружаются и после отказа одного)
// Тот же номер с тем же хэшем — пропуск; с другим — отказ «Выпусков» version_exists: подними номер.
//   --out <папка>   куда собрать папку ядра, .tgz и .sha256; по умолчанию dist/release в корне монорепо
//   --dry-run       только собрать, никуда не загружать
// Из окружения: SWITCHBOARD_RELEASES — адрес Worker'а «Выпусков» флота, SWITCHBOARD_PASS — пропуск программы (ci).
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, buildKeeper, packModule, runGo, runNode, runNpm, upload } from "@switchboard/release";
import type { Exec, GoExec, Put, UploadReply } from "@switchboard/release";
import { loadRepo } from "@switchboard/manifest-gate";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Предел POST releases.upload: вдвое выше самого долгого ответа «Выпусков» (list — 4,8 с) с запасом на сеть. */
const POST_MS = 30_000;

export type Args = { part: "core" | "keeper" | "modules"; out: string; dryRun: boolean };

const USAGE = "вызов: switchboard release core | keeper | modules [--out <папка>] [--dry-run]";

export function parseArgs(argv: string[]): Args {
  const [cmd, part, ...rest] = argv;
  if (cmd !== "release" || (part !== "core" && part !== "keeper" && part !== "modules")) throw new Error(USAGE);
  const a: Args = { part, out: join(root, "dist", "release"), dryRun: false };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (k === "--dry-run") a.dryRun = true;
    else if (k === "--out" && rest[i + 1]) a.out = resolve(rest[++i]);
    else throw new Error(`незнакомый аргумент: ${k}`);
  }
  return a;
}

export type Fetch = (url: string, init: { method: string; body: string | Uint8Array; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Запрос releases.upload к «Выпускам» POST пропуском программы. Нет адреса или пропуска — исключение. */
export function asker(env: Record<string, string | undefined>, f: Fetch = fetch as unknown as Fetch) {
  const url = env.SWITCHBOARD_RELEASES;
  const key = env.SWITCHBOARD_PASS;
  if (!url || !key) throw new Error("нет SWITCHBOARD_RELEASES или SWITCHBOARD_PASS в окружении: адрес «Выпусков» и пропуск программы");
  let n = 0;
  return (part: string, version: string) =>
    async (sha256: string): Promise<UploadReply> => {
      const id = `ci-${++n}`;
      let res;
      try {
        res = await f(url, { method: "POST", body: JSON.stringify({ type: "releases.upload", v: 1, id, part, version, sha256, key }), signal: AbortSignal.timeout(POST_MS) });
      } catch (e) {
        return { ok: false, error: `offline: ${(e as Error).name === "TimeoutError" ? `«Выпуски» не ответили за ${POST_MS / 1000} с` : String(e)}` };
      }
      return (await res.json()) as UploadReply;
    };
}

const exec: Exec = (cmd, args, cwd) => (cmd === "npm" ? runNpm(args, cwd) : runNode(args, cwd));

export async function main(argv: string[], env: Record<string, string | undefined>, x: Exec = exec, go: GoExec = runGo, f: Fetch = fetch as unknown as Fetch): Promise<number> {
  const a = parseArgs(argv);
  const ask = a.dryRun ? null : asker(env, f);
  const put = f as unknown as Put;
  if (a.part === "modules") return modules(ask, put);
  let version: string;
  let tgz: Buffer;
  const part = a.part === "core" ? "host" : a.part;
  if (a.part === "core") {
    const core = JSON.parse(readFileSync(join(root, "host", "core", "module.json"), "utf8")) as { version: string };
    const b = await build({ root, version: core.version, out: a.out, exec: x });
    ({ version, tgz } = b);
    console.log(`собрано ядро host ${version}: ${b.packages.length} пакетов · SDK ${b.check.sdk} · ${tgz.length} байт · sha256 ${b.sha}`);
  } else {
    const k = await buildKeeper(root, go);
    ({ version, tgz } = k);
    console.log(`собран keeper ${version}: ${tgz.length} байт · sha256 ${k.sha}`);
  }
  if (!ask) {
    console.log("--dry-run: никуда не загружено");
    return 0;
  }
  const r = await upload(ask(part, version), version, tgz, put);
  console.log(r.done === "same" ? `${part} ${version} уже загружен с тем же хэшем — пропуск` : `загружено: ${part}/${version}.tgz, .sha256`);
  return 0;
}

type Ask = ReturnType<typeof asker>;

/** Каталог: все модули монорепо, кроме ядра Host и приложений ОС (у них своя сборка). Ответ — выход: 1, если хоть один отказ. */
async function modules(ask: Ask | null, put: Put): Promise<number> {
  const counts = { uploaded: 0, same: 0, built: 0 };
  const refused: string[] = [];
  for (const m of loadRepo(root).filter((x) => x.type !== "os" && x.type !== "sdk-core")) {
    const p = packModule(join(root, m.dir));
    if (!ask) {
      counts.built++;
      continue;
    }
    try {
      counts[(await upload(ask(p.name, p.version), p.version, p.tgz, put)).done]++;
    } catch (e) {
      refused.push(`${p.name} ${p.version}: ${(e as Error).message}`);
    }
  }
  for (const r of refused) console.error(r);
  console.log(`каталог: загружено ${counts.uploaded}, уже были ${counts.same}, собрано без загрузки ${counts.built}, отказов ${refused.length}`);
  return refused.length ? 1 : 0;
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
