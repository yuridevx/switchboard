// switchboard install — первая установка Host на машину: выпуск из R2 по ключу машины, конфиги keeper и Host.
// Ключ машины — из stdin; ключ R2 на чтение выпусков машина просит у points (points.creds), как и host-upgrade.
// Службу keeper ставит отдельно сам keeper (keeper install) — у неё свои права.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { link } from "@switchboard/relay";
import { parseSha, sha256hex, shaKey, tgzKey, latestKey, VERSION_RE } from "./format.ts";
import { s3, type S3Creds } from "./s3.ts";
import { unpack } from "./tar.ts";
import { runNode, runNpm } from "./run.ts";
import { parseCheck } from "./build.ts";

export type InstallArgs = { machine: string; key: string; relay: string; version: string; home: string };

const log = (s: string) => console.log("install: " + s);

/** Ключ R2 на чтение выпусков: короткая связь с relay ключом машины и запрос points.creds. */
async function creds(relay: string, key: string): Promise<S3Creds> {
  const l = link({ url: relay, key, hello: () => ({ sdk: "install", contract: {}, sessions: [] }) });
  try {
    for (let i = 0; l.state !== "open"; i++) {
      if (l.state === "stopped" || i > 300) throw new Error(`relay не принял ключ машины (связь: ${l.state})`);
      await new Promise((r) => setTimeout(r, 50));
    }
    const r = await l.request({ type: "points.creds", v: 1, to: "points" });
    if (!r.ok) throw new Error(`points.creds: ${r.error}`);
    const c = (r.result as { creds?: S3Creds } | undefined)?.creds;
    if (!c) throw new Error("points.creds: ключа нет в ответе");
    return c;
  } finally {
    l.close(1000, "install");
  }
}

export async function install(a: InstallArgs): Promise<void> {
  const b = s3(await creds(a.relay, a.key));
  const get = async (k: string) => {
    const r = await b.get(k);
    if (r.status !== 200) throw new Error(`GET ${k}: ${r.status}`);
    return r.body;
  };
  const version = a.version === "latest" ? (await get(latestKey)).toString("utf8").trim() : a.version;
  if (!VERSION_RE.test(version)) throw new Error(`«${version}» не версия`);
  const want = parseSha((await get(shaKey(version))).toString("utf8"));
  const tgz = await get(tgzKey(version));
  if (sha256hex(tgz) !== want) throw new Error(`хэш ${tgzKey(version)} не сошёлся с ${shaKey(version)}`);
  log(`выпуск ${version} скачан, хэш сошёлся`);

  const dir = join(a.home, "host", version);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  unpack(tgz, dir);
  const ci = await runNpm(["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], dir);
  if (ci.code !== 0) throw new Error(`npm ci: ${ci.out.trim().slice(-2000)}`);
  writeFileSync(join(dir, "release.sha256"), want + "\n");
  const check = parseCheck((await runNode([join(dir, "host"), "--check"], dir)).out);
  if (!check?.ok) throw new Error(`host --check: ${JSON.stringify(check)}`);
  log(`папка ${dir} поставлена, host --check ok`);

  // ключ машины — файлом рядом с конфигом; в host.json — путь от ~
  writeFileSync(join(a.home, "machine.key"), a.key + "\n", { mode: 0o600 });
  const hostJson = join(a.home, "host.json");
  if (!existsSync(hostJson)) {
    writeFileSync(hostJson, JSON.stringify({ machine: a.machine, workers: { relay: { url: a.relay, key: join(a.home, "machine.key") } }, modules: {} }, null, 2) + "\n");
  }
  writeFileSync(join(a.home, "keeper.json"), JSON.stringify({ node: process.execPath, host: version, machine: a.machine }, null, 2) + "\n");
  log(`конфиги в ${a.home}: host.json, keeper.json, machine.key`);
  log("дальше — keeper: «keeper run» в консоли или «keeper install» службой");
}

/** Разбор: switchboard install <машина> [--version <v>|latest] [--relay <wss>]; ключ — из stdin. */
export function installArgs(argv: string[], key: string): InstallArgs {
  const [machine, ...rest] = argv;
  if (!machine || machine.startsWith("--")) throw new Error("вызов: <ключ машины в stdin> | switchboard install <машина> [--version <v>] [--relay <wss>]");
  const a: InstallArgs = {
    machine,
    key,
    relay: "wss://switchboard.yuridevx1608.workers.dev",
    version: "latest",
    home: process.env.SWITCHBOARD_HOME ?? join(homedir(), ".switchboard"),
  };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--version" && rest[i + 1]) a.version = rest[++i];
    else if (rest[i] === "--relay" && rest[i + 1]) a.relay = rest[++i];
    else throw new Error(`незнакомый аргумент: ${rest[i]}`);
  }
  if (!/^host\./.test(key)) throw new Error("в stdin нужен ключ машины host.<имя>.…");
  return a;
}
