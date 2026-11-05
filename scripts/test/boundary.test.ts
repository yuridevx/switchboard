// Леса инструментов разработки, часть без браузера: команды запускаются как процессы, настоящие Cloudflare и флоты не трогаются.
// Подделки — только снаружи: wrangler и сборка подменены предзагрузкой, страница флота — свой сервер, пакеты — временная папка.
// Браузерная часть: npm run shots, npm run drag, scripts/shots/chat.mjs, sandbox.mjs и STAND_CHECK=fake npm run stand:check.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

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

  it("пакет не уложился в предел — FAIL с причиной словами: слово пользователя 2 нояб., у всех операций предел", () => {
    const dir = repo({ "workers/slow": `node -e "setTimeout(()=>{},4000)"` });
    const f = join(temp("packages-pre"), "pre.mjs");
    write(f, `import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const orig = cp.spawn;
cp.spawn = (cmd, args, o = {}) => orig(cmd, args, { ...o, timeout: o.timeout ? 1000 : undefined });
syncBuiltinESMExports();
`);
    const r = run(dir, [], pathToFileURL(f).href);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^FAIL workers\/slow · \d+ с · не уложился в 6 мин$/m);
  });

  it("предел снимает и пакет, чей потомок держит вывод: прогон не ждёт конца потомка (слово пользователя 2 нояб., опыт 5 нояб.: при пределе 1 с ждал все 25 с)", () => {
    const dir = repo({ "workers/hung": `node -e "setTimeout(()=>{},25000)"` });
    const f = join(temp("packages-pre"), "pre.mjs");
    write(f, `import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const orig = cp.spawn;
cp.spawn = (cmd, args, o = {}) => orig(cmd, args, { ...o, timeout: o.timeout ? 1000 : undefined });
syncBuiltinESMExports();
`);
    const started = Date.now();
    const r = run(dir, [], pathToFileURL(f).href);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^FAIL workers\/hung · \d+ с · не уложился в 6 мин$/m);
    expect(Date.now() - started).toBeLessThan(15_000);
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

  it("типы чисты — код 0, строка на пакет; web/pult и web/phone входят в обход; пакет без tsconfig пропущен (чьё: код)", () => {
    const dir = repo({ "web/packages/a": "export const a: number = 1;", "web/pult": "export const b = 1;", "web/phone": "export const c = 1;" });
    mkdirSync(join(dir, "web", "packages", "none"));
    const r = run(dir);
    expect(r.code).toBe(0);
    expect(r.out.trim().split(/\r?\n/).sort()).toEqual(["web/packages/a: ok", "web/phone: ok", "web/pult: ok"]);
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

  /** Предзагрузка: вызовы записываются, дочерний процесс заменён кодом; настоящий Cloudflare не трогается. hang — предел 45 с заменён на 300 мс. */
  function preload(log: string, child: { wrangler?: string; build?: string; hang?: boolean } = {}): string {
    const f = join(temp("deploy-pre"), "pre.mjs");
    write(f, `import cp from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const orig = cp.spawnSync;
cp.spawnSync = (cmd, args, o = {}) => {
  const isBuild = String(args[0]).endsWith("build.mjs");
  const env = o.env ?? process.env;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ what: isBuild ? "build" : "wrangler", cwd: o.cwd, args: isBuild ? [] : args.slice(1), input: o.input, env: { CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID, RELAY_URL: env.RELAY_URL } }) + "\\n");
  const code = isBuild ? ${JSON.stringify(child.build ?? "")} : ${JSON.stringify(child.wrangler ?? "")};
  return orig(cmd, ["-e", code], { ...o, stdio: "ignore", input: undefined, timeout: ${child.hang ? "o.timeout === 45000 ? 300 : o.timeout" : "o.timeout"} });
};
syncBuiltinESMExports();
`);
    return pathToFileURL(f).href;
  }

  function deploy(args: string[], o: { token?: boolean; files?: Record<string, string>; child?: Parameters<typeof preload>[1]; noPreload?: boolean } = {}) {
    const dev = temp("deploy-dev");
    for (const [n, text] of Object.entries(o.files ?? {})) write(join(dev, n), text);
    const log = join(dev, "calls.jsonl");
    const env: Record<string, string | undefined> = { ...process.env, SWITCHBOARD_DEV_DIR: dev };
    for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "RELAY_URL", "VAPID_PRIVATE", "R2_SECRET_ACCESS_KEY", "R2_ACCESS_KEY_ID", "PROD_R2_SECRET_ACCESS_KEY"]) delete env[k];
    if (o.token) Object.assign(env, { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" });
    const r = spawnSync(process.execPath, [...(o.noPreload ? [] : ["--import", preload(log, o.child)]), join(SCRIPTS, "deploy-workers.mjs"), ...args], { env, encoding: "utf8", timeout: CMD_MS });
    const calls: Call[] = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
    return { code: r.status, err: r.stderr, out: r.stdout, calls };
  }
  const SECRETS = { VAPID_PRIVATE: "vapid", R2_SECRET_ACCESS_KEY: "r2-test", R2_ACCESS_KEY_ID: "r2-id", PROD_R2_SECRET_ACCESS_KEY: "r2-prod" };
  const envFile = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join("\n");
  const moduleOf = (c: Call) => c.cwd.split(/[\\/]/).pop();

  it("3153 · номер не того вида — отказ словами, выход 1, ничего не загружено", () => {
    // источник: чьё: код (номер вида 1.1.58)
    const r = deploy(["--upload", "1.1"], { token: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain("deploy: --upload <номер вида 1.1.58>");
    expect(r.calls).toEqual([]);
  });

  it("3154 · нет токена или аккаунта Cloudflare — отказ словами, выход 1", () => {
    // источник: чьё: код
    const r = deploy(["--upload", "1.1.99"], { noPreload: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain("deploy: нет CLOUDFLARE_API_TOKEN или CLOUDFLARE_ACCOUNT_ID");
  });

  it("3155 · wrangler не завершился за предел — убит, причина словами, выход 1: прогон CI красный", () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»; предел — вдвое выше самого долгого шага (22 с)
    const r = deploy(["--upload", "1.1.99"], { token: true, child: { wrangler: "setTimeout(() => {}, 60000)", hang: true } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/deploy: wrangler versions upload .* — не завершился за 45 с/);
  });

  it("5146 · загрузка без выкладки — только Worker-модули: веб не собирается и не загружается", () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): веб больше не загружает
    const r = deploy(["--upload", "1.1.99"], { token: true, child: { build: "process.exit(1)" } });
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/phone|pult/);
    expect(r.out).toContain("deploy: загружено 1.1.99, ничего не выложено");
    expect(r.calls.map(moduleOf)).toEqual(["gate", "push", "points", "ledger", "github", "prefs", "releases", "relay"]);
    expect(r.calls[0]).toMatchObject({ what: "wrangler", args: ["versions", "upload", "--tag", "1.1.99", "--message", "1.1.99"], env: { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" } });
    expect(r.calls.some((c) => c.args.includes("secret"))).toBe(false);
    expect(r.out).toContain("=== workers/gate 1.1.99 ===");
  });

  it("загрузка прода — с --env prod, строка прода в выводе", () => {
    const r = deploy(["--upload", "1.1.99", "--env", "prod"], { token: true });
    expect(r.code).toBe(0);
    expect(r.calls[0].args).toEqual(["versions", "upload", "--env", "prod", "--tag", "1.1.99", "--message", "1.1.99"]);
    expect(r.out).toContain("=== workers/gate 1.1.99 prod ===");
  });

  it("без списка — все Worker-модули: сначала участники и gate, relay последним; база до кода, секреты после и только через stdin", () => {
    // источник: комментарий кода: relay смотрит привязками на остальных; устав: секреты через stdin, никогда через argv
    const r = deploy([], { token: true, files: { "fleet-secrets.env": envFile(SECRETS) } });
    expect(r.code).toBe(0);
    expect(r.out).toContain("deploy: ok · gate, push, points, ledger, github, prefs, releases, relay");
    expect([...new Set(r.calls.map(moduleOf))]).toEqual(["gate", "push", "points", "ledger", "github", "prefs", "releases", "relay"]);
    const of = (m: string) => r.calls.filter((c) => moduleOf(c) === m).map((c) => c.args.slice(0, 3).join(" "));
    expect(of("gate")).toEqual(["d1 migrations apply", "deploy"]);
    expect(of("push")).toEqual(["d1 migrations apply", "deploy", "secret put VAPID_PRIVATE"]);
    expect(of("points")).toEqual(["d1 migrations apply", "deploy", "secret put R2_KEY_SECRET"]);
    expect(of("relay")).toEqual(["deploy"]);
    expect(of("releases")).toEqual(["d1 migrations apply", "deploy", "secret put CLOUDFLARE_API_TOKEN", "secret put R2_LINK_KEY_ID", "secret put R2_LINK_SECRET"]);
    expect(r.calls.find((c) => c.args[0] === "d1")!.args).toEqual(["d1", "migrations", "apply", "DB", "--remote"]);
    const secret = (m: string, k: string) => r.calls.find((c) => moduleOf(c) === m && c.args[2] === k)!;
    expect(secret("push", "VAPID_PRIVATE").input).toBe("vapid");
    expect(secret("points", "R2_KEY_SECRET").input).toBe("r2-test");
    expect(secret("releases", "R2_LINK_KEY_ID").input).toBe("r2-id");
    expect(secret("releases", "CLOUDFLARE_API_TOKEN").input).toBe("t");
    expect(JSON.stringify(r.calls.map((c) => c.args))).not.toMatch(/vapid|r2-test|r2-id/);
  });

  it("названные модули — в порядке выкладки; phone и pult в списке — сборка и выкладка веба; неизвестное имя пропущено", () => {
    const r = deploy(["relay", "pult", "phone", "gate", "что-то"], { token: true });
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => `${moduleOf(c)} ${c.what === "build" ? "build" : c.args[0]}`)).toEqual(["gate d1", "gate deploy", "relay deploy", "phone build", "phone deploy", "pult build", "pult deploy"]);
    expect(r.out).toContain("deploy: ok · gate, relay, phone, pult");
  });

  it("прод: файл прода важнее тестовых, свой секрет точек, адрес relay прода у сборки веба; тестовая пара в прод не кладётся", () => {
    // источник: комментарий кода: тестовая пара прав на бакет прода не имеет
    const r = deploy(["points", "pult", "--env", "prod"], {
      files: {
        "prod.env": envFile({ CLOUDFLARE_API_TOKEN: "prod-token", CLOUDFLARE_ACCOUNT_ID: "prod-acc", PROD_R2_SECRET_ACCESS_KEY: "r2-prod" }),
        "cf-deploy.env": envFile({ CLOUDFLARE_API_TOKEN: "test-token", CLOUDFLARE_ACCOUNT_ID: "test-acc" }),
        "r2-points.env": envFile({ R2_SECRET_ACCESS_KEY: "r2-test" }),
      },
    });
    expect(r.code).toBe(0);
    expect(r.calls.find((c) => c.args[0] === "deploy")).toMatchObject({ args: ["deploy", "--env", "prod"], env: { CLOUDFLARE_API_TOKEN: "prod-token", CLOUDFLARE_ACCOUNT_ID: "prod-acc" } });
    expect(r.calls.find((c) => c.args[0] === "secret")).toMatchObject({ args: ["secret", "put", "R2_KEY_SECRET", "--env", "prod"], input: "r2-prod" });
    expect(r.calls.find((c) => c.what === "build")!.env.RELAY_URL).toBe("wss://relay.pfarm.app");
    expect(r.out).toContain("=== points prod ===");
  });

  it("значение из окружения важнее файла; строка env может содержать знак равно", () => {
    const r = deploy(["push"], { token: true, files: { "cf-deploy.env": "CLOUDFLARE_API_TOKEN=из-файла", "fleet-secrets.env": "VAPID_PRIVATE=a=b=c" } });
    expect(r.code).toBe(0);
    expect(r.calls[0].env.CLOUDFLARE_API_TOKEN).toBe("t");
    expect(r.calls.find((c) => c.args[0] === "secret")!.input).toBe("a=b=c");
  });

  it.each([
    ["нет секрета — отказ именем секрета", ["push"], {}, /deploy: нет секрета VAPID_PRIVATE/],
    ["не прошла сборка веба — отказ, выкладки нет", ["pult"], { child: { build: "process.exit(1)" } }, /deploy: сборка .*pult не прошла/],
    ["wrangler вышел с ошибкой — команда, модуль и код выхода", ["relay"], { child: { wrangler: "process.exit(3)" } }, /deploy: wrangler deploy в workers\/relay — выход 3/],
  ] as const)("%s", (_n, args, o, word) => {
    const r = deploy([...args], { token: true, ...o });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(word);
    expect(r.out).not.toContain("deploy: ok");
  });
});

describe("стенд фронта: сервер", { timeout: CMD_MS }, () => {
  const live: ChildProcess[] = [];
  const pages: Server[] = [];
  afterEach(() => {
    for (const c of live.splice(0)) c.kill();
    for (const s of pages.splice(0)) s.close();
  });

  /** Страница флота: отдаёт build.json с адресами Worker'ов. */
  async function fleetPage(answer: (url: string) => [number, unknown]): Promise<string> {
    const s = createServer((q, res) => {
      const [code, body] = answer(q.url ?? "");
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    pages.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  }

  let port = 21000 + Math.floor(Math.random() * 20000);
  /** Стенд настоящим процессом: страница — лёгкая подделка, адреса флотов — свой сервер. */
  async function stand(o: { live?: boolean; broken?: boolean } = {}) {
    const test = await fleetPage(() => (o.broken ? [500, {}] : [200, { workers: { relay: "wss://test", gate: "https://gate-test" } }]));
    const prod = await fleetPage(() => [200, { workers: { relay: "wss://prod", gate: "https://gate-prod" } }]);
    const out = temp("stand");
    const dir = temp("stand-entry");
    const entry = join(dir, "page.ts");
    write(entry, 'console.log("stand page");\n');
    const base = (port += 2);
    const c = spawn(process.execPath, [join(SCRIPTS, "shots", "dev.mjs")], {
      env: { ...process.env, STAND_OUT: out, STAND_PORT: String(base), STAND_PAGES: JSON.stringify({ test, prod }), ...(o.live ? {} : { STAND_ENTRY: entry }) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    live.push(c);
    let text = "";
    c.stdout!.on("data", (d) => (text += d));
    c.stderr!.on("data", (d) => (text += d));
    const end = Date.now() + 60_000;
    while (!(text.includes("стенд test:") && text.includes("стенд prod:"))) {
      if (Date.now() > end) throw new Error(`стенд не поднялся: ${text}`);
      await new Promise((r) => setTimeout(r, 30));
    }
    const at = (fleet: "test" | "prod") => `http://127.0.0.1:${fleet === "test" ? base : base + 1}`;
    return { c, out, entry, at, log: () => text, file: (fleet: string) => join(out, `comments-${fleet}.json`) };
  }
  const say = (url: string, body: unknown) => fetch(`${url}/api/comments`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
  const NOTE = { text: "Строка низкая", selector: ".bd-row", app: "pult", hash: "#sessions", kind: "test" };

  /** Первое событие потока, удовлетворяющее имени, с пределом. */
  async function eventOf(url: string, name: string, act: () => void | Promise<void>) {
    const ac = new AbortController();
    const r = await fetch(`${url}/events`, { signal: ac.signal });
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const reader = r.body!.getReader();
    await reader.read(); // начало потока
    await act();
    let text = "";
    const limit = setTimeout(() => ac.abort(), 20_000);
    try {
      while (!text.includes(`event: ${name}`)) text += new TextDecoder().decode((await reader.read()).value);
    } catch {
      return false;
    } finally {
      clearTimeout(limit);
      ac.abort();
    }
    return true;
  }

  it("адрес на флот: страница без кэша с рамкой телефона 390, бандл, адреса Worker'ов из build.json своего флота", async () => {
    const s = await stand();
    const html = await fetch(`${s.at("test")}/`);
    expect(html.headers.get("cache-control")).toBe("no-store");
    expect(html.headers.get("content-type")).toContain("text/html");
    const text = await html.text();
    expect(text).toContain("<title>test</title>");
    expect(text).toContain('<div id="app"></div>');
    expect(text).toContain("width:390px");
    expect(text).toContain('s.src = "live.js"');
    expect(await (await fetch(`${s.at("prod")}/`)).text()).toContain("<title>prod</title>");
    const js = await fetch(`${s.at("test")}/live.js`);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(js.headers.get("cache-control")).toBe("no-store");
    expect(await js.text()).toContain("stand page");
    expect(await (await fetch(`${s.at("test")}/fleet.json`)).json()).toEqual({ fleet: "test", workers: { relay: "wss://test", gate: "https://gate-test" } });
    expect(await (await fetch(`${s.at("prod")}/fleet.json`)).json()).toEqual({ fleet: "prod", workers: { relay: "wss://prod", gate: "https://gate-prod" } });
    expect(s.log()).toContain(`стенд test: http://localhost:`);
    expect(s.log()).toContain(`/?app=phone · C — комментарий · ${s.file("test")}`);
  });

  it("страница флота отвечает ошибкой — 502 со словами", async () => {
    const s = await stand({ broken: true });
    const r = await fetch(`${s.at("test")}/fleet.json`);
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "build.json флота test: 500" });
  });

  it("настоящая страница стенда собирается из дерева: приложение и наложение комментариев в одном бандле", async () => {
    const s = await stand({ live: true });
    const js = await (await fetch(`${s.at("test")}/live.js`)).text();
    expect(js).toContain("stand-comments");
    expect(js).toContain("/fleet.json");
    expect(js).toContain("data-module");
  });

  it("комментарий: файл своего флота, строка в выводе для агента; удаление; файл агента читается как есть", async () => {
    // источник: устав: комментарии по C в dist/stand/comments-<флот>.json, агент читает файл и закрывает удалением записи
    const s = await stand();
    expect(await (await fetch(`${s.at("test")}/api/comments`)).json()).toEqual({ comments: [] });
    const r = await say(s.at("test"), NOTE);
    expect(r.status).toBe(200);
    const c = (await r.json()) as { id: string; at: string };
    expect(c).toMatchObject(NOTE);
    expect(c.id).toMatch(/^[\w-]{8}$/);
    expect(Date.parse(c.at)).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(s.file("test"), "utf8"))).toEqual({ comments: [{ ...NOTE, id: c.id, at: c.at }] });
    expect(existsSync(s.file("prod"))).toBe(false);
    expect(await (await fetch(`${s.at("prod")}/api/comments`)).json()).toEqual({ comments: [] });
    expect(s.log()).toContain(`комментарий ${c.id} · test · pult #sessions · .bd-row · Строка низкая`);
    expect((await fetch(`${s.at("test")}/api/comments/${c.id}`, { method: "DELETE" })).status).toBe(200);
    expect(JSON.parse(readFileSync(s.file("test"), "utf8")).comments).toEqual([]);
    // агент записал файл сам
    writeFileSync(s.file("test"), JSON.stringify({ comments: [{ id: "agent", text: "x" }] }));
    expect(await (await fetch(`${s.at("test")}/api/comments`)).json()).toEqual({ comments: [{ id: "agent", text: "x" }] });
    // файл прочли посреди записи: отказ словом, следующее событие перечитает
    writeFileSync(s.file("test"), "{ обрыв");
    expect((await fetch(`${s.at("test")}/api/comments`)).status).toBe(400);
  });

  it.each([
    ["нет текста", { selector: ".a" }, "text и selector — непустые строки"],
    ["текст из пробелов", { text: "  ", selector: ".a" }, "text и selector — непустые строки"],
    ["нет селектора", { text: "a" }, "text и selector — непустые строки"],
    ["больше 64 КиБ", { text: "a".repeat(70_000), selector: ".a" }, "тело больше 64 КиБ"],
  ])("комментарий отклонён словами: %s", async (_n, body, word) => {
    const s = await stand();
    const r = await say(s.at("test"), body);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: word });
    expect(existsSync(s.file("test"))).toBe(false);
  });

  it("чужой адрес — 404 со словами; не JSON — 400", async () => {
    const s = await stand();
    const r = await fetch(`${s.at("test")}/нет`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "нет такого адреса" });
    expect((await say(s.at("test"), "не json")).status).toBe(400);
  });

  it("события: правка исходника — reload всем флотам; файл комментариев изменён — comments только своему флоту", async () => {
    const s = await stand();
    expect(await eventOf(s.at("prod"), "reload", () => writeFileSync(s.entry, 'console.log("stand page 2");\n'))).toBe(true);
    // у каждого флота своя пересборка: событие прода не значит, что файл теста уже новый
    await vi.waitFor(async () => expect(await (await fetch(`${s.at("test")}/live.js`)).text()).toContain("stand page 2"), { timeout: 10_000, interval: 100 });
    expect(await eventOf(s.at("test"), "comments", () => writeFileSync(s.file("test"), JSON.stringify({ comments: [] })))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("3200 · сигнал остановки: соединения закрыты, выход 0 (на Windows сигнала нет)", async () => {
    // источник: устав: каждая часть останавливается штатно
    const s = await stand();
    const ev = await fetch(`${s.at("test")}/events`);
    const closed = ev.text();
    const exit = new Promise<number | null>((r) => s.c.on("close", r));
    s.c.kill("SIGTERM");
    expect(await exit).toBe(0);
    await closed;
  });
});
