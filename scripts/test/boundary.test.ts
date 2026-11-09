// Леса инструментов разработки, часть без браузера: команды запускаются как процессы, настоящие Cloudflare и флоты не трогаются.
// Подделки — только снаружи: wrangler и сборка подменены предзагрузкой, страница флота — свой сервер, пакеты — временная папка.
// Браузерная часть: npm run shots, npm run drag, scripts/shots/chat.mjs и sandbox.mjs.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const SCRIPTS = join(root, "scripts");
const CMD_MS = 120_000;

const temp = (name: string) => mkdtempSync(join(tmpdir(), `${name}-`));
const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const pkg = (name: string, test?: string) => JSON.stringify({ name, private: true, ...(test ? { scripts: { test } } : {}) });

describe("прогон пакетов: test-packages", { timeout: CMD_MS }, () => {
  /** Монорепо во временной папке: скрипт считает корень от своего файла. */
  function repo(packages: Record<string, string | undefined>) {
    const dir = temp("packages");
    write(join(dir, "package.json"), JSON.stringify({ name: "r", private: true, workspaces: ["tools/*", "workers/*", "web/packages/*", "web/phone"] }));
    for (const d of ["tools", "workers", "web/packages"]) mkdirSync(join(dir, d), { recursive: true });
    copyFileSync(join(SCRIPTS, "test-packages.mjs"), (mkdirSync(join(dir, "scripts")), join(dir, "scripts", "test-packages.mjs")));
    for (const [p, test] of Object.entries(packages)) write(join(dir, p, "package.json"), pkg(p.replaceAll("/", "-"), test));
    return dir;
  }
  const run = (dir: string, args: string[] = [], pre?: string) => {
    const r = spawnSync(process.execPath, [...(pre ? ["--import", pre] : []), join(dir, "scripts", "test-packages.mjs"), ...args], { encoding: "utf8", timeout: CMD_MS });
    return { code: r.status, out: r.stdout };
  };
  const OK = `node -e "console.log('зелёный вывод')"`;
  const BAD = `node -e "console.log('причина падения');process.exit(1)"`;

  it("все пакеты прошли — код 0, строка пакета без вывода, итог числом; пакеты без test и tools не запускаются (чьё: код)", () => {
    const r = run(repo({ "workers/a": OK, "web/packages/b": OK, "web/phone": OK, "workers/none": undefined, "tools/t": BAD }));
    expect(r.code).toBe(0);
    for (const d of ["workers/a", "web/packages/b", "web/phone"]) expect(r.out).toMatch(new RegExp(`^ok   ${d} · \\d+ с$`, "m"));
    expect(r.out).toMatch(/^пакетов 3 · упало 0 · \d+ с$/m);
    expect(r.out).not.toContain("зелёный вывод");
    expect(r.out).not.toMatch(/workers\/none|tools\/t/);
  });

  it("упал пакет — код 1, его вывод целиком, остальные доходят: решение 5 нояб., главная судила о прогоне по коду выхода", () => {
    const r = run(repo({ "workers/a": OK, "workers/bad": BAD }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^FAIL workers\/bad · \d+ с$/m);
    expect(r.out).toContain("причина падения");
    expect(r.out).toMatch(/^ok {3}workers\/a/m);
    expect(r.out).toMatch(/^пакетов 2 · упало 1 · \d+ с$/m);
  });

  it("часть пути — только эти пакеты", () => {
    const r = run(repo({ "workers/a": OK, "workers/bad": BAD, "web/phone": OK }), ["web/"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^пакетов 1 · упало 0 · \d+ с$/m);
    expect(r.out).not.toContain("workers/");
  });

  it("пакет не уложился в предел — FAIL с причиной словами, снято всё дерево: потомок мёртв, прогон его не ждёт (слово пользователя 2 нояб., опыт 5 нояб.: при пределе 1 с ждал все 25 с)", () => {
    const dir = repo({ "workers/hung": `node -e "require('fs').writeFileSync('pid',String(process.pid));setTimeout(()=>{},60000)"` });
    const f = join(temp("packages-pre"), "pre.mjs");
    write(f, `const orig = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => orig(fn, ms === 360000 ? 8000 : ms, ...a);
`);
    const started = Date.now();
    const r = run(dir, [], pathToFileURL(f).href);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^FAIL workers\/hung · \d+ с · не уложился в 6 мин$/m);
    expect(Date.now() - started).toBeLessThan(40_000);
    const pid = Number(readFileSync(join(dir, "workers", "hung", "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("типы фронта: web-typecheck", { timeout: CMD_MS }, () => {
  /** Папка внутри репо: npx находит tsc в его node_modules, dist в git не идёт. */
  function repo(files: Record<string, string>) {
    mkdirSync(join(root, "dist"), { recursive: true });
    const dir = mkdtempSync(join(root, "dist", "typecheck-"));
    made.push(dir);
    copyFileSync(join(SCRIPTS, "web-typecheck.mjs"), (mkdirSync(join(dir, "scripts")), join(dir, "scripts", "web-typecheck.mjs")));
    mkdirSync(join(dir, "web", "packages"), { recursive: true });
    for (const [d, code] of Object.entries(files)) {
      write(join(dir, d, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true, strict: true, types: [], skipLibCheck: true }, include: ["*.ts"] }));
      write(join(dir, d, "a.ts"), code);
    }
    return dir;
  }
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const run = (dir: string) => {
    const r = spawnSync(process.execPath, [join(dir, "scripts", "web-typecheck.mjs")], { encoding: "utf8", timeout: CMD_MS });
    return { code: r.status, out: r.stdout };
  };

  it("типы чисты — код 0, строка на пакет; web/pult, web/phone и scripts/design входят в обход; пакет без tsconfig пропущен (чьё: код)", () => {
    const dir = repo({ "web/packages/a": "export const a: number = 1;", "web/pult": "export const b = 1;", "web/phone": "export const c = 1;", "scripts/design": "export const d = 1;" });
    mkdirSync(join(dir, "web", "packages", "none"));
    const r = run(dir);
    expect(r.code).toBe(0);
    expect(r.out.trim().split(/\r?\n/).sort()).toEqual(["scripts/design: ok", "web/packages/a: ok", "web/phone: ok", "web/pult: ok"]);
  });

  it("ошибка типов — код 1, слово «ошибки» и текст компилятора", () => {
    const r = run(repo({ "web/packages/bad": 'export const a: number = "строка";', "web/pult": "export const b = 1;" }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("web/packages/bad: ошибки");
    expect(r.out).toContain("TS2322");
    expect(r.out).toContain("web/pult: ok");
  });
});

describe("выпуск Worker-модулей: deploy-workers", { timeout: CMD_MS }, () => {
  type Call = { what: "build" | "wrangler"; cwd: string; args: string[]; input?: string; env: Record<string, string | undefined> };

  /** Предзагрузка: вызовы записываются, дочерний процесс заменён кодом; настоящий Cloudflare не трогается. hang — предел 300 с заменён на 300 мс. */
  function preload(log: string, child: { wrangler?: string; build?: string; hang?: boolean } = {}): string {
    const f = join(temp("deploy-pre"), "pre.mjs");
    write(f, `import cp from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const orig = cp.spawnSync;
cp.spawnSync = (cmd, args, o = {}) => {
  const isBuild = String(args[0]).endsWith("build.mjs");
  const env = o.env ?? process.env;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ what: isBuild ? "build" : "wrangler", cwd: o.cwd, args: isBuild ? [] : args.slice(1), input: o.input, env: { CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID } }) + "\\n");
  const code = isBuild ? ${JSON.stringify(child.build ?? "")} : ${JSON.stringify(child.wrangler ?? "")};
  return orig(cmd, ["-e", code], { ...o, stdio: "ignore", input: undefined, timeout: ${child.hang ? "o.timeout === 300000 ? 300 : o.timeout" : "o.timeout"} });
};
syncBuiltinESMExports();
globalThis.fetch = async (url, init) => {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ what: "fetch", cwd: "fetch", args: [String(url)], input: init.headers.authorization, env: {} }) + String.fromCharCode(10));
  return new Response("{}");
};
`);
    return pathToFileURL(f).href;
  }

  function deploy(args: string[], o: { token?: boolean; files?: Record<string, string>; child?: Parameters<typeof preload>[1] } = {}) {
    const dev = temp("deploy-dev");
    for (const [n, text] of Object.entries(o.files ?? {})) write(join(dev, n), text);
    const log = join(dev, "calls.jsonl");
    const env: Record<string, string | undefined> = { ...process.env, SWITCHBOARD_DEV_DIR: dev };
    for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "RELAY_URL", "VAPID_PRIVATE", "R2_SECRET_ACCESS_KEY", "R2_ACCESS_KEY_ID", "PROD_R2_SECRET_ACCESS_KEY", "TELEGRAM_BOT_TOKEN", "PROD_TELEGRAM_BOT_TOKEN", "CH_PASSWORD_TEST", "CH_PASSWORD_PROD"]) delete env[k];
    if (o.token) Object.assign(env, { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" });
    const r = spawnSync(process.execPath, ["--import", preload(log, o.child), join(SCRIPTS, "deploy-workers.mjs"), ...args], { env, encoding: "utf8", timeout: CMD_MS });
    const calls: Call[] = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
    return { code: r.status, err: r.stderr, out: r.stdout, calls };
  }
  const SECRETS = { VAPID_PRIVATE: "vapid", R2_SECRET_ACCESS_KEY: "r2-test", R2_ACCESS_KEY_ID: "r2-id", PROD_R2_SECRET_ACCESS_KEY: "r2-prod", TELEGRAM_BOT_TOKEN: "bot-test", PROD_TELEGRAM_BOT_TOKEN: "bot-prod", CH_PASSWORD_TEST: "ch-test", CH_PASSWORD_PROD: "ch-prod" };
  const envFile = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join("\n");
  const moduleOf = (c: Call) => c.cwd.split(/[\\/]/).pop();
  const WORKERS = ["gate", "rooms", "push", "blocks-ch", "points", "ledger", "github", "prefs", "fleetkeys", "releases", "mcp", "relay"];

  it.each([
    ["", [], ""],
    [" прода", ["--env", "prod"], " prod"],
  ] as const)("5146 · загрузка%s без выкладки — только Worker-модули: веб не собирается и не загружается", (_n, env, tail) => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): веб больше не загружает
    const r = deploy(["--upload", "1.1.99", ...env], { token: true, child: { build: "process.exit(1)" } });
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/phone|pult/);
    expect(r.out).toContain("deploy: загружено 1.1.99, ничего не выложено");
    expect(r.calls.map(moduleOf)).toEqual(WORKERS);
    expect(r.calls[0]).toMatchObject({ what: "wrangler", args: ["versions", "upload", ...env, "--tag", "1.1.99", "--message", "1.1.99"], env: { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" } });
    expect(r.calls.some((c) => c.args.includes("secret"))).toBe(false);
    expect(r.out).toContain(`=== workers/gate 1.1.99${tail} ===`);
  });

  it.each([
    ["теста", [], "ch-test", "bot-test", "https://switchboard-rooms.yuridevx1608.workers.dev/setup"],
    ["прода: пароль ClickHouse свой, ссылки выпусков — из общих имён", ["--env", "prod"], "ch-prod", "bot-prod", "https://rooms.pfarm.app/setup"],
  ] as const)("без списка, флот %s — все Worker-модули, relay последним; база до кода, секреты после и только через stdin", (_n, env, points, bot, setup) => {
    // источник: комментарий кода: relay смотрит привязками на остальных; устав: секреты через stdin, никогда через argv
    const r = deploy([...env], { token: true, files: { "fleet-secrets.env": envFile(SECRETS) } });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`deploy: ok · ${WORKERS.join(", ")}`);
    const hooked = r.calls.filter((c) => c.what === "fetch");
    expect(hooked.map((c) => [c.args[0], c.input])).toEqual([[setup, `Bearer ${bot}`]]);
    r.calls.splice(r.calls.indexOf(hooked[0]), 1);
    expect([...new Set(r.calls.map(moduleOf))]).toEqual(WORKERS);
    const of = (m: string) => r.calls.filter((c) => moduleOf(c) === m).map((c) => c.args.slice(0, c.args[0] === "deploy" ? 1 : 3).join(" "));
    expect(of("gate")).toEqual(["d1 migrations apply", "deploy"]);
    expect(of("push")).toEqual(["d1 migrations apply", "deploy", "secret put VAPID_PRIVATE"]);
    expect(of("blocks-ch")).toEqual(["deploy", "secret put CH_PASSWORD"]);
    expect(of("points")).toEqual(["d1 migrations apply", "deploy"]);
    expect(of("relay")).toEqual(["deploy"]);
    expect(of("releases")).toEqual(["d1 migrations apply", "deploy", "secret put CLOUDFLARE_API_TOKEN", "secret put R2_LINK_KEY_ID", "secret put R2_LINK_SECRET"]);
    expect(r.calls.find((c) => c.args[0] === "d1")!.args).toEqual(["d1", "migrations", "apply", "DB", "--remote", ...env]);
    for (const c of r.calls) expect(c.args.includes("--env") ? c.args.slice(-2) : []).toEqual(env);
    expect(r.calls.filter((c) => c.args[0] === "secret").map((c) => [moduleOf(c), c.args[2], c.input])).toEqual([
      ["rooms", "TELEGRAM_BOT_TOKEN", bot],
      ["push", "VAPID_PRIVATE", "vapid"],
      ["blocks-ch", "CH_PASSWORD", points],
      ["releases", "CLOUDFLARE_API_TOKEN", "t"],
      ["releases", "R2_LINK_KEY_ID", "r2-id"],
      ["releases", "R2_LINK_SECRET", "r2-test"],
    ]);
    expect(JSON.stringify(r.calls.map((c) => c.args))).not.toMatch(/vapid|r2-test|r2-id|ch-test|ch-prod|bot-test|bot-prod/);
  });

  it("названные модули — в порядке выкладки; phone и pult в списке — сборка и выкладка веба; неизвестное имя пропущено", () => {
    const r = deploy(["relay", "pult", "phone", "gate", "что-то"], { token: true });
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => `${moduleOf(c)} ${c.what === "build" ? "build" : c.args[0]}`)).toEqual(["gate d1", "gate deploy", "relay deploy", "phone build", "phone deploy", "pult build", "pult deploy"]);
    expect(r.out).toContain("deploy: ok · gate, relay, phone, pult");
  });

  it.each([
    ["прод: файл прода важнее тестовых, тестовый пароль ClickHouse в прод не кладётся", ["--env", "prod"], " prod", "prod", "ch-prod"],
    ["тест: файл прода не читается (чьё: код)", [], "", "test", "ch-test"],
  ] as const)("%s", (_n, env, tail, who, secret) => {
    // источник: комментарий кода: тестовый пользователь ClickHouse прав на базу прода не имеет
    const r = deploy(["blocks-ch", "pult", ...env], {
      files: {
        "prod.env": envFile({ CLOUDFLARE_API_TOKEN: "prod-token", CLOUDFLARE_ACCOUNT_ID: "prod-acc" }),
        "cf-deploy.env": envFile({ CLOUDFLARE_API_TOKEN: "test-token", CLOUDFLARE_ACCOUNT_ID: "test-acc" }),
        "clickhouse.env": envFile({ CH_PASSWORD_TEST: "ch-test", CH_PASSWORD_PROD: "ch-prod" }),
      },
    });
    expect(r.code).toBe(0);
    expect(r.calls.find((c) => c.args[0] === "deploy")).toMatchObject({ args: ["deploy", ...env], env: { CLOUDFLARE_API_TOKEN: `${who}-token`, CLOUDFLARE_ACCOUNT_ID: `${who}-acc` } });
    expect(r.calls.find((c) => c.args[0] === "secret")).toMatchObject({ args: ["secret", "put", "CH_PASSWORD", ...env], input: secret });
    expect(r.out).toContain(`=== blocks-ch${tail} ===`);
  });

  it("значение из окружения важнее файла; строка env может содержать знак равно", () => {
    const r = deploy(["push"], { token: true, files: { "cf-deploy.env": "CLOUDFLARE_API_TOKEN=из-файла", "fleet-secrets.env": "VAPID_PRIVATE=a=b=c" } });
    expect(r.code).toBe(0);
    expect(r.calls[0].env.CLOUDFLARE_API_TOKEN).toBe("t");
    expect(r.calls.find((c) => c.args[0] === "secret")!.input).toBe("a=b=c");
  });

  it.each([
    ["3153 · номер не того вида — отказ до загрузки (чьё: код)", ["--upload", "1.1"], {}, /deploy: --upload <номер вида 1\.1\.58>/, 0],
    ["3154 · нет токена или аккаунта Cloudflare (чьё: код)", ["--upload", "1.1.99"], { token: false }, /deploy: нет CLOUDFLARE_API_TOKEN или CLOUDFLARE_ACCOUNT_ID/, 0],
    ["3154 · есть токен, нет аккаунта Cloudflare (чьё: код)", ["--upload", "1.1.99"], { token: false, files: { "cf-deploy.env": "CLOUDFLARE_API_TOKEN=t" } }, /deploy: нет CLOUDFLARE_API_TOKEN или CLOUDFLARE_ACCOUNT_ID/, 0],
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»; 300 с — настоящая выкладка 5 нояб.: при 45 с wrangler deploy выложил prefs, но не завершился под нагрузкой, и выкладка оборвалась на полпути
    ["3155 · wrangler не завершился за предел — убит, прогон CI красный", ["--upload", "1.1.99"], { child: { wrangler: "setTimeout(() => {}, 60000)", hang: true } }, /deploy: wrangler versions upload .* — не завершился за 300 с/, 1],
    ["нет секрета — отказ именем секрета", ["push"], {}, /deploy: нет секрета VAPID_PRIVATE/, undefined],
    ["опечатка в имени флота — отказ, а не выкладка на тест", ["relay", "--env", "prd"], {}, /deploy: --env — только prod/, 0],
    ["не прошла сборка веба — отказ, выкладки нет", ["pult"], { child: { build: "process.exit(1)" } }, /deploy: сборка .*pult не прошла/, 1],
    ["wrangler вышел с ошибкой — команда, модуль и код выхода", ["relay"], { child: { wrangler: "process.exit(3)" } }, /deploy: wrangler deploy в workers\/relay — выход 3/, 1],
  ] as const)("%s", (_n, args, o, word, calls) => {
    const r = deploy([...args], { token: true, ...o });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(word);
    expect(r.out).not.toContain("deploy: ok");
    if (calls !== undefined) expect(r.calls).toHaveLength(calls);
  });
});
