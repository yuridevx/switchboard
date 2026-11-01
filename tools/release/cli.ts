#!/usr/bin/env node
// switchboard release host <версия> [--out <папка>] [--dry-run | --to <папка>]
// switchboard release keeper [--dry-run | --to <папка>]
//
// Собирает часть машины из монорепо и загружает её в бакет R2 switchboard-releases: <часть>/<версия>.tgz,
// затем <часть>/<версия>.sha256. Не выкладывает: stable двигает «выпуски» (releases.deploy).
//   host     ядро и модули host/core/modules.json, проверка host --check; номер — аргументом (CI: 1.1.<прогон>)
//   keeper   файлы для Windows и Linux одним архивом; номер — из os/keeper/module.json. Номер уже загружен
//            с тем же хэшем — пропуск; с другим — отказ «подними номер keeper»
//   --out <папка>   куда собрать папку выпуска Host, .tgz и .sha256; по умолчанию dist/release в корне монорепо
//   --dry-run       только собрать, никуда не загружать
//   --to <папка>    загрузить в местную папку той же раскладки, что бакет (поддельный R2 для проверок)
// Ключ R2 на запись — из окружения: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT (https://<аккаунт>.r2.cloudflarestorage.com).
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "./src/build.ts";
import type { Exec } from "./src/build.ts";
import { RELEASES_BUCKET } from "./src/format.ts";
import { buildKeeper, runGo } from "./src/keeper.ts";
import type { GoExec } from "./src/keeper.ts";
import { dirBucket, s3Bucket, upload } from "./src/publish.ts";
import type { Bucket } from "./src/publish.ts";
import { runNode, runNpm } from "./src/run.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type Args = { part: "host" | "keeper"; version?: string; out: string; dryRun: boolean; to?: string };

const USAGE = "вызов: switchboard release host <версия> | keeper [--out <папка>] [--dry-run | --to <папка>]";

export function parseArgs(argv: string[]): Args {
  const [cmd, part, ...rest] = argv;
  if (cmd !== "release" || (part !== "host" && part !== "keeper")) throw new Error(USAGE);
  const a: Args = { part, out: join(root, "dist", "release"), dryRun: false };
  if (part === "host") {
    a.version = rest.shift();
    if (!a.version || a.version.startsWith("--")) throw new Error(USAGE);
  }
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (k === "--dry-run") a.dryRun = true;
    else if (k === "--out" && rest[i + 1]) a.out = resolve(rest[++i]);
    else if (k === "--to" && rest[i + 1]) a.to = resolve(rest[++i]);
    else throw new Error(`незнакомый аргумент: ${k}`);
  }
  if (a.dryRun && a.to) throw new Error("--dry-run и --to вместе не бывают");
  return a;
}

/** Бакет по аргументам: местная папка или R2 по ключу из окружения. */
export function bucketOf(a: Args, env: Record<string, string | undefined>): Bucket | null {
  if (a.dryRun) return null;
  if (a.to) return dirBucket(a.to);
  const { R2_ACCESS_KEY_ID: id, R2_SECRET_ACCESS_KEY: secret, R2_ENDPOINT: endpoint } = env;
  if (!id || !secret || !endpoint) throw new Error("нет ключа R2 в окружении: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT");
  return s3Bucket({ accessKeyId: id, secretAccessKey: secret, endpoint, bucket: RELEASES_BUCKET });
}

const exec: Exec = (cmd, args, cwd) => (cmd === "npm" ? runNpm(args, cwd) : runNode(args, cwd));

export async function main(argv: string[], env: Record<string, string | undefined>, x: Exec = exec, go: GoExec = runGo): Promise<number> {
  const a = parseArgs(argv);
  const bucket = bucketOf(a, env);
  let version: string;
  let tgz: Buffer;
  let sha: string;
  if (a.part === "host") {
    const b = await build({ root, version: a.version!, out: a.out, exec: x });
    ({ version, tgz, sha } = b);
    console.log(`собран host ${version}: ${b.packages.length} пакетов · SDK ${b.check.sdk} · ${tgz.length} байт · sha256 ${sha}`);
  } else {
    ({ version, tgz, sha } = await buildKeeper(root, go));
    console.log(`собран keeper ${version}: ${tgz.length} байт · sha256 ${sha}`);
  }
  if (!bucket) {
    console.log("--dry-run: никуда не загружено");
    return 0;
  }
  const r = await upload(bucket, a.part, version, tgz, sha);
  console.log(r === "same" ? `${a.part} ${version} уже загружен с тем же хэшем — пропуск` : `загружено в ${bucket.where}: ${a.part}/${version}.tgz, .sha256`);
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
