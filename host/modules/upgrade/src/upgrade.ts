// Модуль upgrade: новая версия Host из выпусков в R2. Скачать по ключу от points, сверить хэш, npm ci —
// и отдать ядру host.reload: те же ядро и SDK — модули перезагружаются в живом Host; иначе core_changed,
// проверка host --check отдельным процессом и просьба к keeper подменить Host.
// Сам ничего не ищет и не повторяет: только по запросу, отказ — словом с причиной в журнале.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Refusal, refuse } from "@switchboard/host";
import type { Ctx, Host, Module } from "@switchboard/host";
import { latestKey, parseCheck, parseSha, runNode, runNpm, s3, sha256hex, shaKey, tgzKey, unpack, VERSION_RE } from "@switchboard/release";
import type { Fetch, RunResult, S3Creds } from "@switchboard/release";

export type UpgradeOptions = {
  /** ~/.switchboard: папки версий — host/<версия>/ */
  home: string;
  fetch: Fetch;
  /** npm ci в папке версии */
  npm: (args: string[], cwd: string, signal: AbortSignal) => Promise<RunResult>;
  /** node <папка>/host --check */
  node: (args: string[], cwd: string, signal: AbortSignal) => Promise<RunResult>;
  /** версия папки, из которой работает ядро этого процесса: её не убирать */
  running: string | null;
};

/** Папка версии, из которой запущен Host: keeper запускает node <папка версии>/host. */
function runningVersion(): string | null {
  const entry = process.argv[1];
  return entry && basename(entry) === "host" ? basename(dirname(entry)) : null;
}

const defaults = (): UpgradeOptions => ({
  home: process.env.SWITCHBOARD_HOME ?? join(homedir(), ".switchboard"),
  fetch: fetch as unknown as Fetch,
  npm: (args, cwd, signal) => runNpm(args, cwd, { signal }),
  node: (args, cwd, signal) => runNode(args, cwd, { signal }),
  running: runningVersion(),
});

/** Файл в папке версии: хэш архива, из которого она поставлена. Нет или другой — папка не та, ставится заново. */
const STAMP = "release.sha256";

export function upgrade(over: Partial<UpgradeOptions> = {}): Module {
  const o = { ...defaults(), ...over };
  const versions = join(o.home, "host");
  /** идущее обновление: до какой версии */
  let busy: string | null = null;
  let host!: Host;

  /** Бинарники claude внутри папки версии: их удаляем первыми — на Windows запущенный файл ОС удалить не даст. */
  function claudeBinaries(dir: string): string[] {
    const scope = join(dir, "node_modules", "@anthropic-ai");
    if (!existsSync(scope)) return [];
    const out: string[] = [];
    for (const p of readdirSync(scope)) {
      if (!p.startsWith("claude-agent-sdk-")) continue;
      for (const b of ["claude.exe", "claude"]) if (existsSync(join(scope, p, b))) out.push(join(scope, p, b));
    }
    return out;
  }

  /** Уборка: папки всех версий, кроме текущей и той, из которой работает ядро. Занятая — остаётся до следующей уборки. */
  function cleanup(): void {
    if (!existsSync(versions)) return;
    const keep = new Set([host.version, o.running, busy].filter((x): x is string => !!x));
    for (const v of readdirSync(versions)) {
      const dir = join(versions, v);
      if (keep.has(v) || !VERSION_RE.test(v) || !statSync(dir).isDirectory()) continue;
      try {
        for (const b of claudeBinaries(dir)) rmSync(b, { force: true });
        rmSync(dir, { recursive: true, force: true });
        host.log({ ev: "cleanup", version: v, why: `папка ${v} удалена` });
      } catch (e) {
        host.log({ kind: "note", ev: "cleanup", version: v, word: (e as NodeJS.ErrnoException).code, why: `папка ${v} занята — остаётся до следующей уборки` });
      }
    }
  }

  /** Ключ R2 на чтение выпусков — у points. */
  async function bucket(): Promise<ReturnType<typeof s3>> {
    const r = await host.request("points.creds", { v: 1 });
    if (!r.ok) throw refuse("download_failed", `points.creds: ${r.error}`);
    const c = (r.result as { creds?: S3Creds } | undefined)?.creds;
    if (!c) throw refuse("download_failed", "points.creds: ключа нет в ответе");
    return s3(c, o.fetch);
  }

  /** Сбой не словом (сеть, архив) — download_failed с причиной; отказ словом — как есть. */
  const failed = (e: unknown, what: string): Refusal => (e instanceof Refusal ? e : refuse("download_failed", `${what}: ${(e as Error).message}`));

  async function fetchKey(b: ReturnType<typeof s3>, key: string, signal: AbortSignal) {
    try {
      return await b.get(key, signal);
    } catch (e) {
      throw failed(e, `GET ${key}`);
    }
  }

  /** Объект бакета: нет — no_release, другой статус — download_failed. */
  async function get(b: ReturnType<typeof s3>, key: string, signal: AbortSignal): Promise<Buffer> {
    const r = await fetchKey(b, key, signal);
    if (r.status === 404) throw refuse("no_release", `в R2 нет ${key}`);
    if (r.status !== 200) throw refuse("download_failed", `GET ${key}: ${r.status}`);
    return r.body;
  }

  /** Скачать архив, сверить хэш, распаковать, npm ci. Не вышло — папка убрана, download_failed. */
  async function install(b: ReturnType<typeof s3>, to: string, want: string, dir: string, signal: AbortSignal): Promise<void> {
    const r = await fetchKey(b, tgzKey(to), signal);
    if (r.status !== 200) throw refuse("download_failed", `GET ${tgzKey(to)}: ${r.status}`);
    const got = sha256hex(r.body);
    if (got !== want) throw refuse("download_failed", `${to}: хэш архива ${got}, а в ${shaKey(to)} — ${want}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    try {
      unpack(r.body, dir);
      const ci = await o.npm(["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], dir, signal);
      if (ci.code !== 0) throw refuse("download_failed", `${to}: npm ci — ${ci.out.trim().slice(-2000)}`);
      writeFileSync(join(dir, STAMP), want + "\n");
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw failed(e, to);
    }
  }

  /** После ответа: keeper подменяет Host. Ответ keeper — в журнал флота или в журнал машины. */
  async function swap(from: string, to: string, by: string | undefined): Promise<void> {
    const r = await host.request("upgrade", { v: 1, version: to });
    busy = null;
    if (!r.ok) return host.log({ kind: "stop", ev: "upgrade", word: r.error, why: `keeper отказал в upgrade ${from} → ${to}: ${r.error}` });
    ledger(from, to, by);
  }

  function ledger(from: string, to: string, by: string | undefined): void {
    const r = host.emit({ type: "ledger.add", to: "ledger", v: 1, ev: "machine.upgraded", text: `${host.machine}: Host ${from} → ${to}`, ...(by ? { by } : {}), machine: host.machine });
    if (!r.ok) host.log({ kind: "note", ev: "ledger", word: r.error, why: `machine.upgraded ${from} → ${to} не записан в журнал флота` });
  }

  async function run(req: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
    const { signal } = ctx;
    const v = req.version as string;
    const b = await bucket();
    const to = v === "latest" ? (await get(b, latestKey, signal)).toString("utf8").trim() : v;
    if (!VERSION_RE.test(to)) throw refuse("download_failed", `${latestKey}: «${to}» не версия`);
    const want = parseSha((await get(b, shaKey(to), signal)).toString("utf8"));
    if (!want) throw refuse("download_failed", `${shaKey(to)}: не строка хэша`);
    if (req.dryRun === true) return { from: host.version, to };
    if (to === host.version) throw refuse("already_current", `machine.upgrade ${v}: ${to} уже работает`);
    busy = to;
    const dir = join(versions, to);
    const stamp = join(dir, STAMP);
    const fresh = !(existsSync(stamp) && readFileSync(stamp, "utf8").trim() === want);
    if (fresh) await install(b, to, want, dir, signal);
    else host.log({ ev: "upgrade", version: to, why: `папка ${to} уже поставлена из того же архива — без скачивания` });
    const from = host.version;
    const sdkFrom = host.sdk;
    const r = await host.reload(dir);
    if (r.ok) {
      ledger(from, to, ctx.from);
      return { from, to, sdk: { from: sdkFrom, to: host.sdk }, restart: false, modules: Object.keys(r.result.modules) };
    }
    if (r.error === "module_error") throw refuse("module_error", r.why);
    if (r.error === "check_failed") {
      if (fresh) rmSync(dir, { recursive: true, force: true });
      throw refuse("check_failed", r.why);
    }
    // core_changed: другое ядро или SDK — проверить отдельным процессом и просить keeper
    const c = parseCheck((await o.node(["host", "--check"], dir, signal)).out);
    if (!c.ok || c.version !== to) {
      if (fresh) rmSync(dir, { recursive: true, force: true });
      throw refuse("check_failed", `${to}: ${c.ok ? `версия в пакете ${c.version}` : c.why}`);
    }
    // ответ уйдёт до остановки Host; keeper — после него
    setImmediate(() => void swap(from, to, ctx.from));
    return { from, to, sdk: { from: sdkFrom, to: c.sdk }, restart: true };
  }

  return {
    start(h) {
      host = h;
      cleanup();
    },

    on: {
      open(s) {
        // процесс поднят этим Host заново: старая папка могла освободиться
        if (s.info.start !== "attach") cleanup();
      },
    },

    requests: {
      async "machine.upgrade"(req, ctx) {
        const v = req.version;
        if (typeof v !== "string" || !(v === "latest" || VERSION_RE.test(v))) throw refuse("bad_frame", `machine.upgrade: version ${JSON.stringify(v)}`);
        if (req.dryRun !== true && v === host.version) throw refuse("already_current", `machine.upgrade ${v}: уже работает`);
        if (busy) throw refuse("upgrade_running", `machine.upgrade ${v}: идёт обновление до ${busy}`);
        busy = v;
        let swapping = false;
        try {
          const r = await run(req, ctx);
          swapping = (r as { restart?: boolean }).restart === true;
          return r;
        } catch (e) {
          // остановка Host: начатое скачивание оборвано, папку убрал install
          if (ctx.signal.aborted) throw refuse("shutting_down", `machine.upgrade ${v}: Host останавливается — ${(e as Error).message}`);
          throw e;
        } finally {
          if (!swapping) busy = null;
        }
      },
    },
  };
}
