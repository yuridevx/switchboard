#!/usr/bin/env node
// switchboard release <версия> [--out <папка>] [--dry-run | --to <папка>]
//
// Собирает выпуск Host из монорепо (ядро и модули host/core/modules.json), проверяет его host --check
// и выкладывает в бакет R2 switchboard-releases: host/<версия>.tgz, host/<версия>.sha256, последним host/latest.
//   --out <папка>   куда собрать папку выпуска, .tgz и .sha256; по умолчанию dist/release в корне монорепо
//   --dry-run       только собрать и проверить, никуда не выкладывать
//   --to <папка>    выложить в местную папку той же раскладки, что бакет (поддельный R2 для проверок)
// Ключ R2 на запись — из окружения: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT (https://<аккаунт>.r2.cloudflarestorage.com).
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "./src/build.ts";
import type { Exec } from "./src/build.ts";
import { RELEASES_BUCKET } from "./src/format.ts";
import { assertNew, dirBucket, publish, s3Bucket } from "./src/publish.ts";
import type { Bucket } from "./src/publish.ts";
import { runNode, runNpm } from "./src/run.ts";
import { install, installArgs } from "./src/install.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type Args = { version: string; out: string; dryRun: boolean; to?: string };

export function parseArgs(argv: string[]): Args {
  const [cmd, version, ...rest] = argv;
  if (cmd !== "release" || !version) throw new Error("вызов: switchboard release <версия> [--out <папка>] [--dry-run | --to <папка>]");
  const a: Args = { version, out: join(root, "dist", "release"), dryRun: false };
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

async function stdin(): Promise<string> {
  const parts: Buffer[] = [];
  for await (const c of process.stdin) parts.push(c as Buffer);
  return Buffer.concat(parts).toString("utf8").trim();
}

export async function main(argv: string[], env: Record<string, string | undefined>, x: Exec = exec): Promise<number> {
  if (argv[0] === "install") {
    await install(installArgs(argv.slice(1), await stdin()));
    return 0;
  }
  const a = parseArgs(argv);
  const bucket = bucketOf(a, env);
  if (bucket) await assertNew(bucket, a.version);
  const b = await build({ root, version: a.version, out: a.out, exec: x });
  console.log(`собран ${a.version}: ${b.packages.length} пакетов · SDK ${b.check.sdk} · ${b.tgz.length} байт · sha256 ${b.sha}`);
  console.log(`  ${join(a.out, a.version + ".tgz")}`);
  if (!bucket) {
    console.log("--dry-run: никуда не выложено");
    return 0;
  }
  const keys = await publish(bucket, a.version, b.tgz, b.sha);
  console.log(`выложено в ${bucket.where}: ${keys.join(", ")}`);
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
