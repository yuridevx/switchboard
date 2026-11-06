// Леса границы «Каталог модулей», среда Node: формат выпуска (контракт release), CLI выпуска (main и packFromRepo) и инструменты
// сессии parts (контракт host-parts) на стенде Host. Снаружи — «Выпуски», R2, go, npm и node: подделки. Номер — эталон-источник; без номера — чьё: код.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import { make } from "@switchboard/host-parts";
import { BUILD_FILE, entries, manifestOf, pack, packModule, presign, sha256hex, shaLine, WEB_FILE, webBuild, type BuildList } from "@switchboard/release";
import manifest from "../../../host/modules/parts/module.json" with { type: "json" };
import { main, type Fetch } from "../cli.ts";
import { packFromRepo } from "../src/module.ts";
import { run } from "../src/spawn.ts";

const root = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const tmp = (name = "switchboard-release-") => mkdtempSync(join(tmpdir(), name));
const versionOf = (dir: string) => (JSON.parse(readFileSync(join(root, dir, "module.json"), "utf8")) as { version: string }).version;
const files = (tgz: Buffer) => entries(tgz).filter((e) => e.data);
const text = (tgz: Buffer, path: string) => entries(tgz).find((e) => e.path === path)!.data!.toString("utf8");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

afterEach(() => vi.restoreAllMocks());

const KEEPER_JSON = "{\n  \"name\": \"keeper\",\n  \"type\": \"os\",\n  \"version\": \"1.2.1\",\n  \"provides\": { \"keeper.state\": 1 },\n  \"uses\": { \"releases.plan@releases\": 1, \"ledger.add@ledger\": 1, \"gate.redeem@gate\": 1, \"hello@relay\": 1, \"roster@relay\": 1 },\n  \"config\": {}\n}\n";

describe("формат выпуска", () => {
  it("байты архива и строки .sha256 закреплены: настоящий каталог хранит выпуски в этом формате; туда и обратно — файлы, папки из путей, режим, длинный путь (чьё: код; слово главной сессии — формат не меняется)", () => {
    const long = "packages/" + "a".repeat(70) + "/" + "b".repeat(70) + "/file.ts";
    const tgz = pack([
      { path: "src/a.ts", data: Buffer.from("export const a = 1;\n") },
      { path: "module.json", data: Buffer.from('{"name":"m","version":"1.0.0"}') },
      { path: "run", data: Buffer.from("#!/bin/sh\n"), mode: 0o755 },
      { path: long, data: Buffer.alloc(700, 65) },
    ]);
    // tar без сжатия: gzip на разных машинах даёт разные байты при том же tar
    expect(sha(gunzipSync(tgz))).toBe("856b0997034453bdd7279e9a99368538f35801fb271c633e4b6d6492d5b9769c");
    expect(entries(tgz).map((e) => e.path).slice(0, 2)).toEqual(["module.json", "packages/"]);
    const gzip = gzipSync(gunzipSync(tgz), { level: 9 });
    gzip[9] = 3;
    expect(tgz).toEqual(gzip);
    // факт CI 42119677969: Linux дал 69e30ba7…, Windows 110a9e79…; вся разница — байт ОС заголовка gzip (3 и 10)
    const keeper = (path: string, text: string) => ({ path, data: Buffer.from(text), mode: 0o755 });
    const ci = pack([{ path: "module.json", data: Buffer.from(KEEPER_JSON) }, keeper("windows-amd64/keeper.exe", "keeper windows/amd64"), keeper("linux-amd64/keeper", "keeper linux/amd64")]);
    expect(sha256hex(ci)).toBe("69e30ba747b2f2244146c6421a38e8fb8f82769ebfd4e5297df3a575d71e17ec");
    const got = new Map(files(tgz).map((e) => [e.path, e.data!]));
    expect(got.size).toBe(4);
    expect(got.get("src/a.ts")!.toString()).toBe("export const a = 1;\n");
    expect(got.get(long)).toEqual(Buffer.alloc(700, 65));
    expect(entries(tgz).find((e) => e.path === "run")?.mode).toBe(0o755);
    expect(() => pack([{ path: "x".repeat(101), data: Buffer.from("") }])).toThrow(`имя в архиве слишком длинное: ${"x".repeat(101)}`);
    const h = sha256hex("x");
    expect(shaLine(h, "1.4.1")).toBe(`${h}  1.4.1.tgz\n`);
    expect(h).toBe("2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881");
  });

  it("путь вне папки в архиве и запись особого вида — исключение; манифест читается по началу архива, без него — null", async () => {
    expect(() => entries(pack([{ path: "../evil", data: Buffer.from("x") }]))).toThrow("путь вне архива");
    const tar = gunzipSync(pack([{ path: "a", data: Buffer.from("") }]));
    tar[156] = "2".charCodeAt(0);
    expect(() => entries(gzipSync(tar))).toThrow("запись вида 2 в архиве: a");
    const big = pack([{ path: "module.json", data: Buffer.from('{"name":"m"}') }, { path: "z", data: Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 7919) % 251)) }]);
    expect(await manifestOf(big.subarray(0, 2048))).toEqual({ name: "m" });
    expect(await manifestOf(pack([{ path: "app.json", data: Buffer.from("{}") }]))).toBeNull();
  });

  it("ссылка — пример AWS: GET test.txt на сутки", async () => {
    const url = await presign(
      { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" },
      { method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", now: new Date("2013-05-24T00:00:00Z"), expires: 86400 },
    );
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
    // по умолчанию — регион auto и час, сегменты пути кодируются
    const own = await presign({ accessKeyId: "AK", secretAccessKey: "SK" }, { method: "PUT", host: "h.test", path: "/b/test/host/1.2.0+1.tgz", now: new Date("2026-11-05T00:00:00Z") });
    expect(own).toContain("https://h.test/b/test/host/1.2.0%2B1.tgz?");
    expect(own).toContain("X-Amz-Credential=AK%2F20261105%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261105T000000Z&X-Amz-Expires=3600&");
  });
});

describe("упаковка модуля", () => {
  it("5113 · 5191 · 5192 · виды: Worker — только module.json с именами по флотам; модуль пакета — файлы без тестов и настроек; ОС — dist/ с режимом; module.json первым и байт в байт; тот же модуль — тот же хэш", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): имён Worker'ов в манифестах, написанных руками, 0;
    // отчёт слепого архитектора 2 нояб.: одна упаковка «папка модуля → архив» у parts.upload и release-cli
    const d = tmp();
    writeFileSync(join(d, "module.json"), JSON.stringify({ name: "hello-worker", type: "worker", version: "0.1.0", provides: {}, uses: {}, config: {} }));
    writeFileSync(join(d, "wrangler.jsonc"), `// Worker\n{ "name": "hello", /* тест */ "main": "src/index.ts", "env": { "prod": { "routes": ["https://x//y"], }, "eu": { "name": "hello-eu" } } }`);
    const w = packModule(d);
    expect(entries(w.tgz).map((e) => e.path)).toEqual(["module.json"]);
    expect(await manifestOf(w.tgz)).toMatchObject({ name: "hello-worker", version: "0.1.0", workers: { test: "hello", prod: "hello-prod", eu: "hello-eu" } });

    const h = tmp();
    mkdirSync(join(h, "src"));
    mkdirSync(join(h, "test"));
    writeFileSync(join(h, "contract.ts"), "export {};\n");
    writeFileSync(join(h, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(h, "src", "a.test.ts"), "x");
    writeFileSync(join(h, "test", "b.ts"), "x");
    writeFileSync(join(h, "tsconfig.json"), "{}");
    writeFileSync(join(h, "vitest.config.ts"), "x");
    writeFileSync(join(h, "module.json"), JSON.stringify({ name: "hello-host", type: "sdk", version: "0.1.0", into: ["host"] }));
    const m = packModule(h);
    expect(entries(m.tgz).map((e) => e.path)).toEqual(["module.json", "contract.ts", "src/", "src/a.ts"]);
    expect(await manifestOf(m.tgz)).toMatchObject({ name: "hello-host", into: ["host"] });
    expect(packModule(h).sha).toBe(m.sha);
    expect(m.sha).toBe(sha256hex(m.tgz));
    expect([m.name, m.version]).toEqual(["hello-host", "0.1.0"]);

    const o = tmp();
    mkdirSync(join(o, "dist"));
    writeFileSync(join(o, "module.json"), '{ "name": "daemon", "type": "os", "version": "0.1.0" }');
    writeFileSync(join(o, "dist", "app.json"), '{"run":["./d"]}');
    writeFileSync(join(o, "dist", "d"), "#!/bin/sh");
    chmodSync(join(o, "dist", "d"), 0o755);
    const os = files(packModule(o).tgz);
    expect(os.map((e) => e.path)).toEqual(["module.json", "app.json", "d"]);
    expect(os[0].data!.toString()).toBe('{ "name": "daemon", "type": "os", "version": "0.1.0" }');
    if (process.platform !== "win32") expect(os[2].mode).toBe(0o755);

    // ОС без dist/ — файлы пакета с app.json в корне; web — свой module.js или bundle вызывающего; web-app — статика dist/ с именами Worker'а
    const flat = tmp();
    writeFileSync(join(flat, "module.json"), '{"name":"d2","type":"os","version":"1.0.0"}');
    writeFileSync(join(flat, "app.json"), "{}");
    writeFileSync(join(flat, "m.mjs"), "1");
    expect(files(packModule(flat).tgz).map((e) => e.path)).toEqual(["module.json", "app.json", "m.mjs"]);
    const page = tmp();
    writeFileSync(join(page, "module.json"), JSON.stringify({ name: "tab", type: "web", version: "1.0.0" }));
    writeFileSync(join(page, "contract.ts"), "export {};");
    expect(text(packModule(page, { bundle: () => Buffer.from("// собрано") }).tgz, WEB_FILE)).toBe("// собрано");
    const shell = tmp();
    mkdirSync(join(shell, "dist"));
    writeFileSync(join(shell, "module.json"), JSON.stringify({ name: "app", type: "web-app", version: "1.0.0" }));
    writeFileSync(join(shell, "wrangler.jsonc"), '{ "name": "sw-app" }');
    writeFileSync(join(shell, "dist", "index.html"), "<html>");
    const sh = packModule(shell);
    expect(entries(sh.tgz).map((e) => e.path)).toEqual(["module.json", "index.html"]);
    expect(await manifestOf(sh.tgz)).toMatchObject({ workers: { test: "sw-app" } });
  });

  it.each<[string, Record<string, string>, RegExp | string]>([
    ["ОС без app.json", { "module.json": '{"name":"x","type":"os","version":"1.0.0"}' }, /^no_app_json: у приложения ОС x нет app\.json — ни в dist\/, ни в корне$/],
    ["workers руками", { "module.json": '{"name":"x","type":"sdk","version":"1.0.0","workers":{}}' }, "x: workers в module.json пишет упаковка из wrangler-настройки, не рука"],
    ["Worker без wrangler", { "module.json": '{"name":"x","type":"worker","version":"1.0.0"}' }, "x: у модуля типа worker нет wrangler.jsonc"],
    ["оболочка без dist", { "module.json": '{"name":"x","type":"web-app","version":"1.0.0"}', "wrangler.jsonc": '{"name":"x"}' }, "x: у оболочки нет dist/ — собери её статику"],
    ["страница без файла", { "module.json": '{"name":"x","type":"web","version":"1.0.0"}' }, "x: у модуля страницы нет module.js — собери его одним файлом"],
  ])("упаковка отказывает словом: %s", (_n, content, word) => {
    const d = tmp();
    for (const [p, s] of Object.entries(content)) writeFileSync(join(d, p), s);
    expect(() => packModule(d)).toThrow(word);
  });

  it("5131 · 5167 · модуль страницы монорепо — module.json и один ES-файл (другие модули страницы — внешние импорты, протокол — внутри) и рядом папка пакета с контрактом и стендом; тот же код — тот же хэш", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): «Веб: один файл ES-модуля»
    const p = packFromRepo(join(root, "web/pult/modules/points"));
    const paths = entries(p.tgz).map((e) => e.path);
    expect(paths[0]).toBe("module.json");
    expect(paths).toEqual(expect.arrayContaining([WEB_FILE, "contract.ts"]));
    expect(paths.some((x) => x.startsWith("test/"))).toBe(false);
    // ядро страницы отдаёт и стенд: чужой репо тестирует экраны на нём (5167)
    const core = packFromRepo(join(root, "web/packages/core"));
    expect(entries(core.tgz).map((e) => e.path)).toEqual(expect.arrayContaining(["stand/app.ts", "stand/relay.ts"]));
    expect(await manifestOf(p.tgz)).toMatchObject({ name: "pult-points", type: "web", into: ["pult"] });
    const js = text(p.tgz, WEB_FILE);
    // 5711: рантайм и набор внешние, ядро модуль не импортирует, копии рантайма в файле нет
    expect([...new Set(js.match(/from\s*"@switchboard\/[a-z-]+"/g))].sort()).toEqual(['from"@switchboard/web-ui"', 'from"@switchboard/web-view"']);
    expect(js).not.toContain("react.transitional.element");
    expect(js).not.toContain("@switchboard/protocol");
    expect(js).toContain("export");
    expect([...new Set(text(core.tgz, WEB_FILE).match(/from\s*"@switchboard\/[a-z-]+"/g))].sort()).toEqual(['from"@switchboard/web-ui"', 'from"@switchboard/web-view"']);
    // рантайм страницы сам себя не выносит наружу: в его файле копия React
    expect(text(packFromRepo(join(root, "web/packages/view")).tgz, WEB_FILE)).toContain("react.transitional.element");
    expect(packFromRepo(join(root, "web/pult/modules/points")).sha).toBe(p.sha);
  });

  it("5132 · оболочка монорепо — module.json с именами Worker'а по флотам и статика без адресов relay, Worker'ов и модулей", async () => {
    // источник: дизайн «Открытый флот»: адресов relay в коде оболочек 0; имя Worker'а — из wrangler
    const p = packFromRepo(join(root, "web/pult"));
    const paths = entries(p.tgz).map((e) => e.path);
    expect(paths[0]).toBe("module.json");
    expect(paths).toEqual(expect.arrayContaining(["index.html", "app.js", "sw.js", "manifest.webmanifest", "icon-192.png"]));
    expect(paths).not.toContain("_headers");
    // 5711: в обработчике пушей рантайма страницы нет
    expect(text(p.tgz, "sw.js")).not.toContain("react.transitional.element");
    expect(paths.some((x) => x.startsWith("m/") || x === "build.json")).toBe(false);
    expect(await manifestOf(p.tgz)).toMatchObject({ name: "pult", type: "web-app", workers: { test: "switchboard-pult", prod: "switchboard-pult-prod" } });
    for (const f of ["index.html", "app.js", "sw.js"]) expect(text(p.tgz, f)).not.toMatch(/wss:\/\/|workers\.dev|pfarm\.app/);
  }, 60_000);
});

describe("сборка страницы", () => {
  const shellOf = (version: string, html: string) => pack([{ path: "module.json", data: Buffer.from(JSON.stringify({ version })) }, { path: "index.html", data: Buffer.from(html) }, { path: "app.js", data: Buffer.from("boot()") }, { path: "sw.js", data: Buffer.from("sw") }]);
  const mod = (name: string) => ({ name, tgz: pack([{ path: "module.json", data: Buffer.from("{}") }, { path: WEB_FILE, data: Buffer.from(`// ${name}`) }]) });
  const listOf = (version: string, ...modules: Array<[string, string]>): BuildList => ({ app: "pult", version, fleet: "test", modules: modules.map(([name, v]) => ({ name, version: v })), workers: { gate: "https://gate.test/", relay: "https://relay.test/" } });

  it("5133 · 5712 · раскладка: оболочка в корне без module.json, app.<версия>.js, m/<модуль>.<версия>.js по списку, _headers одного правила вечного кэша, build.json; нет файла модуля — отказ с именем", () => {
    // источник: дизайн «Открытый флот»: сборщик только раскладывает; дизайн «Новая модульность фронта»: запросов при повторном запуске 6 → 1
    const shell = shellOf("1.3.0", '<!doctype html><head><script src="app.js" defer></script></head>');
    const list = listOf("1.3.0+1", ["web-view", "19.3.1"], ["web-chat", "2.0.0"]);
    const out = webBuild(shell, [mod("web-chat"), mod("web-view")], list);
    expect(out.map((f) => f.path)).toEqual(["app.1.3.0.js", "index.html", "sw.js", "m/web-view.19.3.1.js", "m/web-chat.2.0.0.js", "_headers", BUILD_FILE]);
    expect(out.find((f) => f.path === "m/web-chat.2.0.0.js")!.data.toString()).toBe("// web-chat");
    expect(out.find((f) => f.path === "app.1.3.0.js")!.data.toString()).toBe("boot()");
    expect(JSON.parse(out.at(-1)!.data.toString())).toEqual(list);
    expect(out.at(-1)!.data.toString()).toBe(JSON.stringify(list, null, 2) + "\n");
    expect(out.find((f) => f.path === "_headers")!.data.toString()).toBe("/m/*\n  Cache-Control: public, max-age=31536000, immutable\n/app.*.js\n  Cache-Control: public, max-age=31536000, immutable\n");
    const html = out.find((f) => f.path === "index.html")!.data.toString();
    expect(html).toContain('<link rel="modulepreload" href="./m/web-view.19.3.1.js">');
    expect(html).toContain('<link rel="modulepreload" href="./m/web-chat.2.0.0.js">');
    expect(html).toContain('src="app.1.3.0.js"');
    expect(html.indexOf('type="importmap"')).toBeLessThan(html.indexOf("modulepreload"));
    expect(() => webBuild(shell, [mod("web-view")], list)).toThrow("web-chat: в архиве модуля нет module.js");
    expect(() => webBuild(shell, [mod("web-chat"), { name: "web-view", tgz: pack([{ path: "module.json", data: Buffer.from("{}") }]) }], list)).toThrow("web-view: в архиве модуля нет module.js");
  });

  it.each([
    ["5180 · есть скрипт: до первого скрипта — маячок домена (модуль) её не опередит", '<!doctype html><html><head><meta charset="utf-8"><script src="app.js" defer></script></head><body></body></html>', (o: string, m: number) => m < o.indexOf('<script src="app.1.2.1.js"') && m > o.indexOf("<meta")],
    ["скрипта нет: перед концом head", "<!doctype html><head><meta charset=utf-8></head><body>", (o: string, m: number) => m < o.indexOf("</head>") && m > o.indexOf("<meta")],
    ["ни скрипта, ни head: сразу после doctype", "<!doctype html><body>", (o: string, m: number) => m === "<!doctype html>".length && o.endsWith("<body>")],
  ])("карта импорта в index.html: %s", (_n, html, placed) => {
    // источник: прод 3 нояб. — на pult.pfarm.app маячок Web Analytics грузился раньше карты: «Failed to resolve module specifier», страница не стартовала
    const list = listOf("1.2.1+1", ["web-core", "1.3.2"], ["web-board", "1.4.2"]);
    const out = webBuild(shellOf("1.2.1", html), [mod("web-core"), mod("web-board")], list).find((f) => f.path === "index.html")!.data.toString();
    const at = out.indexOf('<script type="importmap">');
    expect(placed(out, at)).toBe(true);
    expect(JSON.parse(out.slice(at + '<script type="importmap">'.length, out.indexOf("</script>", at)))).toEqual({
      imports: { "@switchboard/web-core": "./m/web-core.1.3.2.js", "@switchboard/web-board": "./m/web-board.1.4.2.js" },
    });
  });
});

const ENV = { SWITCHBOARD_RELEASES: "https://releases.test", SWITCHBOARD_PASS: "client.ci.k1.s3cret" };
type Go = NonNullable<Parameters<typeof main>[3]>;
type Exec = NonNullable<Parameters<typeof main>[2]>;

const go: Go = async (args, _cwd, env) => {
  const out = args[args.indexOf("-o") + 1];
  mkdirSync(join(out, ".."), { recursive: true });
  writeFileSync(out, `keeper ${env.GOOS}/${env.GOARCH}`);
  return { code: 0, out: "" };
};

/** «Выпуски» и R2: POST отвечает по тому, что уже лежит; PUT кладёт в объекты. */
function fakeFleet() {
  const objects = new Map<string, Buffer>();
  const posts: Array<Record<string, unknown>> = [];
  const f: Fetch = async (url, init) => {
    if (init.method === "POST") {
      const fr = JSON.parse(String(init.body)) as Record<string, string>;
      posts.push(fr);
      if (fr.type === "releases.fetch" && !objects.has(`${fr.part}/${fr.version}.tgz`)) return { ok: true, status: 200, json: async () => ({ type: "reply", id: fr.id, ok: false, error: "no_release" }) };
      if (fr.type === "releases.fetch") return { ok: true, status: 200, json: async () => ({ type: "reply", id: fr.id, ok: true, result: { version: fr.version, url: `https://r2.test/b/${fr.part}/${fr.version}.tgz` } }) };
      const had = objects.get(`${fr.part}/${fr.version}.sha256`);
      const reply = had
        ? had.toString("utf8").split(/\s+/)[0] === fr.sha256
          ? { type: "reply", id: fr.id, ok: true, result: { same: true } }
          : { type: "reply", id: fr.id, ok: false, error: "version_exists" }
        : { type: "reply", id: fr.id, ok: true, result: { tgz: `https://r2.test/b/${fr.part}/${fr.version}.tgz`, sha256: `https://r2.test/b/${fr.part}/${fr.version}.sha256` } };
      return { ok: true, status: 200, json: async () => reply };
    }
    const key = new URL(url).pathname.slice("/b/".length);
    if (init.method !== "PUT") {
      const o = objects.get(key);
      return { ok: !!o, status: o ? 200 : 404, json: async () => ({}), arrayBuffer: async () => new Uint8Array(o ?? []).buffer } as never;
    }
    objects.set(key, Buffer.from(init.body as Uint8Array));
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { f, objects, posts };
}

/** Вывод CLI: строки console.log и console.error. */
function output() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((s: unknown) => void out.push(String(s)));
  vi.spyOn(console, "error").mockImplementation((s: unknown) => void err.push(String(s)));
  return { out, err };
}

const HOST = versionOf("host/core");
/** Подделка npm и node: lockfile, node_modules и ответ host --check. */
const execOk = (ran: string[] = []): Exec => async (cmd, args, cwd) => {
  ran.push(`${cmd} ${args.join(" ")}`);
  if (cmd === "npm" && args[0] === "install") writeFileSync(join(cwd, "package-lock.json"), "{}");
  if (cmd === "npm" && args[0] === "ci") mkdirSync(join(cwd, "node_modules", "x"), { recursive: true });
  if (cmd === "node") return { code: 0, out: `шум\n{ "ok": true, "version": "${HOST}", "sdk": "0.3.311", "proto": 1 }\n` };
  return { code: 0, out: "" };
};

describe("CLI выпуска", () => {
  it.each<[string, string[], Record<string, string>, string]>([
    ["не release", ["build", "core"], ENV, "вызов: switchboard release core | keeper | modules [--out <папка>] [--dry-run] | check"],
    ["незнакомый аргумент", ["release", "core", "--to", "x"], ENV, "незнакомый аргумент: --to"],
    ["2077 нет пропуска", ["release", "keeper"], { SWITCHBOARD_RELEASES: "https://x" }, "нет SWITCHBOARD_RELEASES или SWITCHBOARD_PASS в окружении: адрес «Выпусков» и пропуск программы"],
    ["check спрашивает каталог и с --dry-run (спорное место: было «cat is not a function»)", ["release", "check", "--dry-run"], {}, "нет SWITCHBOARD_RELEASES или SWITCHBOARD_PASS в окружении: адрес «Выпусков» и пропуск программы"],
  ])("2077 · аргументы и окружение — отказ словом: %s", async (_n, argv, env, word) => {
    const fl = fakeFleet();
    await expect(main(argv, env, execOk(), go, fl.f)).rejects.toThrow(word);
    expect(fl.posts).toEqual([]);
  });

  it("3179 · сборка без загрузки: архив собран, «Выпуски» не спрошены, выход 0; строка с хэшем для проверки CI", async () => {
    // источник: чьё: код; CI сравнивает строку «sha256 …» двух сборок keeper
    const o = output();
    const fl = fakeFleet();
    expect(await main(["release", "keeper", "--dry-run"], {}, execOk(), go, fl.f)).toBe(0);
    expect(o.out.some((l) => new RegExp(`^собран keeper ${versionOf("os/keeper").replaceAll(".", "\\.")}: \\d+ байт · sha256 [0-9a-f]{64}$`).test(l))).toBe(true);
    expect(o.out).toContain("--dry-run: никуда не загружено");
    expect(fl.posts).toEqual([]);
    expect(await main(["release", "modules", "--dry-run"], {}, execOk(), go, fl.f)).toBe(0);
    expect(o.out.at(-1)).toMatch(/^каталог: загружено 0, уже были 0, собрано без загрузки \d+, отказов 0$/);
    expect(fl.posts).toEqual([]);
  }, 60_000);

  it("3180 · 5142 · keeper: releases.upload пропуском программы с хэшем, архив и .sha256 по ссылкам; module.json первым, два файла по ОС, режим исполнения, флаги без сведений git; тот же номер второй раз — пропуск", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): CI грузит запросом POST releases.upload пропуском программы ci;
    // факт CI 1 нояб. — ревизия коммита в файле меняла хэш при неизменном коде
    const o = output();
    const fl = fakeFleet();
    const seen: string[][] = [];
    const g: Go = (args, cwd, env) => (seen.push(args), go(args, cwd, env));
    expect(await main(["release", "keeper"], ENV, execOk(), g, fl.f)).toBe(0);
    expect(await main(["release", "keeper"], ENV, execOk(), g, fl.f)).toBe(0);
    const v = versionOf("os/keeper");
    const tgz = fl.objects.get(`keeper/${v}.tgz`)!;
    expect(fl.objects.get(`keeper/${v}.sha256`)!.toString("utf8")).toBe(shaLine(sha256hex(tgz), v));
    expect(fl.posts[0]).toMatchObject({ type: "releases.upload", v: 1, part: "keeper", version: v, sha256: sha256hex(tgz), key: ENV.SWITCHBOARD_PASS });
    expect(o.out).toContain(`загружено: keeper/${v}.tgz, .sha256`);
    expect(o.out).toContain(`keeper ${v} уже загружен с тем же хэшем — пропуск`);
    expect(files(tgz).map((e) => [e.path, e.path === "module.json" ? "" : e.data!.toString(), e.mode])).toEqual([
      ["module.json", "", 0o644],
      ["linux-amd64/keeper", "keeper linux/amd64", 0o755],
      ["windows-amd64/keeper.exe", "keeper windows/amd64", 0o755],
    ]);
    expect(seen.every((x) => x.includes("-buildvcs=false") && x.includes("-trimpath") && x.includes("-s -w -buildid="))).toBe(true);
    await expect(main(["release", "keeper", "--dry-run"], {}, execOk(), async () => ({ code: 1, out: "syntax error\n" }), fl.f)).rejects.toThrow("go build windows/amd64: syntax error");
  });

  it("ядро: module.json первым, вход host, workspaces, app.json, пакеты ядра и его зависимости без модулей и тестов; npm и host --check по порядку; .tgz и .sha256 в --out; архив без node_modules", async () => {
    const o = output();
    const out = tmp();
    const ran: string[] = [];
    const fl = fakeFleet();
    expect(await main(["release", "core", "--dry-run", "--out", out], {}, execOk(ran), go, fl.f)).toBe(0);
    expect(ran.map((r) => r.split(" ").slice(0, 3).join(" "))).toEqual(["npm install --package-lock-only", "npm ci --omit=dev", "node host --check"]);
    expect(ran[0]).toBe("npm install --package-lock-only --ignore-scripts --no-audit --no-fund");
    expect(ran[1]).toBe("npm ci --omit=dev --ignore-scripts --no-audit --no-fund");
    expect(o.out.some((l) => new RegExp(`^собрано ядро host ${HOST.replaceAll(".", "\\.")}: \\d+ пакетов · SDK 0\\.3\\.311 · \\d+ байт · sha256 [0-9a-f]{64}$`).test(l))).toBe(true);
    const tgz = readFileSync(join(out, `${HOST}.tgz`));
    expect(readFileSync(join(out, `${HOST}.sha256`), "utf8")).toBe(shaLine(sha256hex(tgz), HOST));
    const dir = join(out, HOST);
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
    const paths = entries(tgz).map((e) => e.path);
    expect(paths[0]).toBe("module.json");
    expect(await manifestOf(tgz)).toMatchObject({ name: "host", type: "sdk-core" });
    expect(paths).toEqual(expect.arrayContaining(["host", "package.json", "package-lock.json", "app.json", "packages/host/main.ts", "packages/host/stand/host.ts", "packages/protocol/contract.ts", "packages/release/contract.ts", "packages/relay/contract.ts", "packages/manifest-gate/contract.ts", "packages/gate/contract.ts"]));
    expect(paths.some((p) => p.includes("node_modules") || p.includes(".test.") || p.includes("/test/") || p.startsWith("packages/host-"))).toBe(false);
    expect(entries(tgz).find((e) => e.path === "host")?.mode).toBe(0o755);
    expect(text(tgz, "host")).toBe('// Вход выпуска Host: keeper запускает node host в папке версии.\nimport "./packages/host/main.ts";\n');
    expect(JSON.parse(text(tgz, "package.json"))).toEqual({ name: "switchboard-host-release", version: HOST, private: true, type: "module", workspaces: ["packages/*"] });
    const corePj = JSON.parse(text(tgz, "packages/host/package.json"));
    expect(corePj.dependencies).toEqual({ "@anthropic-ai/claude-agent-sdk": "0.3.311", zod: "4.4.3" });
    expect(corePj.scripts).toBeUndefined();
    expect(corePj).toMatchObject({ name: "@switchboard/host", private: true, type: "module" });
    // Host — часть машины, как приложение: keeper ставит его по app.json
    expect(JSON.parse(text(tgz, "app.json"))).toEqual({ run: ["node", "host"], setup: ["npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], detach_children: true });
  }, 60_000);

  it.each<[string, Exec, string]>([
    ["npm install", async (cmd, args) => ({ code: cmd === "npm" && args[0] === "install" ? 1 : 0, out: cmd === "npm" && args[0] === "install" ? "npm install упал" : "" }), "npm install --package-lock-only: npm install упал"],
    ["host --check отказал", async (cmd) => ({ code: cmd === "node" ? 1 : 0, out: cmd === "node" ? '{ "ok": false, "why": "session.cost: два владельца — cost и dup" }' : "" }), "host --check: session.cost: два владельца — cost и dup"],
    ["host --check: другая версия", async (cmd) => ({ code: 0, out: cmd === "node" ? '{ "ok": true, "version": "0.0.1" }' : "" }), `host --check: версия 0.0.1, а собиралась ${HOST}`],
    ["host --check без ответа", async () => ({ code: 0, out: "" }), "host --check: host --check без ответа"],
    ["host --check: не JSON", async (cmd) => ({ code: 0, out: cmd === "node" ? "{ сломано" : "" }), "host --check: { сломано"],
  ])("2076 · ядро не собралось — исключение с причиной, архива нет: %s", async (_n, exec, word) => {
    const out = tmp();
    await expect(main(["release", "core", "--dry-run", "--out", out], {}, exec, go, fakeFleet().f)).rejects.toThrow(word);
    expect(existsSync(join(out, `${HOST}.tgz`))).toBe(false);
  }, 60_000);

  it("«Выпуски» не ответили на POST — отказ словом с причиной", async () => {
    const fail: Fetch = async () => {
      throw new Error("нет сети");
    };
    await expect(main(["release", "keeper"], ENV, execOk(), go, fail)).rejects.toThrow("releases.upload: offline: Error: нет сети");
  });

  it("процесс сборки — с пределом: держит ввод и не выходит — снят, вывод и причина в ответе; обычный выход — код и вывод", async () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»; настоящий дочерний процесс
    const r = await run(process.execPath, ["-e", "console.log('работаю'); setInterval(() => {}, 1000)"], tmpdir(), { limitMs: 1500 });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("работаю");
    expect(r.out).toContain("не завершился за 1.5 с");
    expect(await run(process.execPath, ["-e", "console.error('x'); process.exit(3)"], tmpdir())).toEqual({ code: 3, out: "x\n" });
  }, 15_000);

  it("процесс оставил потомка с тем же выводом — предел всё равно держится", async () => {
    // источник: комментарий старого кода «вывод держит потомок: после снятия ответ ждём недолго»; слово пользователя 2 нояб. «у всех операций должен быть лимит»
    const grandchild = "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit' }); setInterval(() => {}, 1000)";
    const started = Date.now();
    const r = await run(process.execPath, ["-e", grandchild], tmpdir(), { limitMs: 1000 });
    expect(r.out).toContain("не завершился за 1 с");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it("5143 · modules: каждый модуль каталога — своим запросом, кроме ядра и приложений ОС; отказ одного — выход 1 с его именем, остальные загружены", async () => {
    // источник: чьё: код (остальные модули загружаются и после отказа одного)
    const o = output();
    const fl = fakeFleet();
    // под нынешним номером protocol лежит другое содержимое
    const pv = versionOf("protocol");
    fl.objects.set(`protocol/${pv}.sha256`, Buffer.from(`${"0".repeat(64)}  ${pv}.tgz\n`));
    fl.objects.set(`protocol/${pv}.tgz`, pack([{ path: "module.json", data: Buffer.from("{}") }]));
    expect(await main(["release", "modules"], ENV, execOk(), go, fl.f)).toBe(1);
    expect(o.err).toEqual([expect.stringMatching(/^protocol \d+\.\d+\.\d+: releases\.upload: version_exists/)]);
    expect(fl.posts.map((p) => p.part)).not.toContain("host");
    expect(fl.posts.map((p) => p.part)).not.toContain("keeper");
    expect([...fl.objects.keys()].some((k) => /^push\/[\d.]+\.tgz$/.test(k))).toBe(true);
    expect(o.out.at(-1)).toMatch(/^каталог: загружено \d+, уже были 0, собрано без загрузки 0, отказов 1$/);
  }, 60_000);

  it("5196 · check: код как в каталоге — выход 0; содержимое под тем же номером другое — выход 1 и «подними номер» с файлом; новый номер — не отказ; lockfile ядра не сравнивается; ничего не загружает", async () => {
    // источник: слово пользователя 3 нояб. («да» на правку 10): два прогона CI упали только из-за номера, узнавать это до push
    const o = output();
    const fl = fakeFleet();
    expect(await main(["release", "modules"], ENV, execOk(), go, fl.f)).toBe(0);
    // ядро в каталоге — архив той же сборки с чужим lockfile: его пишет npm, он не сравнивается
    const out = tmp();
    await main(["release", "core", "--dry-run", "--out", out], {}, execOk(), go, fl.f);
    const core = files(readFileSync(join(out, `${HOST}.tgz`))).map((e) => ({ path: e.path, data: e.path === "package-lock.json" ? Buffer.from('{"чужой":1}') : e.data!, mode: e.mode }));
    fl.objects.set(`host/${HOST}.tgz`, pack(core));
    const count = fl.objects.size;
    expect(await main(["release", "check"], ENV, execOk(), go, fl.f)).toBe(0);
    expect(o.out.at(-1)).toMatch(/^каталог: как в коде \d+, новых номеров 0, поднять 0$/);
    expect(fl.objects.size).toBe(count);
    const uploads = fl.posts.filter((p) => p.type === "releases.upload").length;

    const pv = versionOf("protocol");
    fl.objects.set(`protocol/${pv}.tgz`, pack([{ path: "module.json", data: Buffer.from("{}") }]));
    fl.objects.set(`host/${HOST}.tgz`, pack(core.map((f) => (f.path === "packages/protocol/contract.ts" ? { ...f, data: Buffer.from("// другое") } : f))));
    fl.objects.delete(`push/${versionOf("workers/push")}.tgz`);
    expect(await main(["release", "check"], ENV, execOk(), go, fl.f)).toBe(1);
    expect(o.err.some((x) => x.startsWith(`подними номер: protocol ${pv}: `))).toBe(true);
    expect(o.err.some((x) => x === `подними номер: host ${HOST}: packages/protocol/contract.ts`)).toBe(true);
    expect(o.out.at(-1)).toMatch(/^каталог: как в коде \d+, новых номеров 1, поднять 2$/);
    expect(fl.posts.filter((p) => p.type === "releases.upload")).toHaveLength(uploads);
  }, 90_000);

  it.each<[string, Fetch, RegExp]>([
    ["отказ каталога", async (_u, init) => ({ ok: true, status: 200, json: async () => ({ ok: false, error: "bad_key", id: JSON.parse(String(init.body)).id }) }), /releases\.fetch .*: bad_key/],
    ["R2 не отдал архив", async (_u, init) => (init.method === "POST" ? { ok: true, status: 200, json: async () => ({ ok: true, result: { version: "1.0.0", url: "https://r2.test/x" } }) } : { ok: false, status: 403, json: async () => ({}) }), /: R2 ответил 403$/],
  ])("5197 · check: %s — исключение словами, а не «всё в порядке»", async (_n, f, word) => {
    // источник: устав — ошибка словом; проверка, которая не может упасть, проверкой не считается
    output();
    await expect(main(["release", "check"], ENV, execOk(), go, f)).rejects.toThrow(word);
  }, 60_000);
});

const { module, standHost } = stand;
type Stand = stand.Stand;
const stands: Stand[] = [];
afterEach(async () => {
  for (const s of stands.splice(0)) await s.close();
});

/** ответ; null — молчать; undefined — ответа у теста нет: список машин отвечает сам */
type Answer = (f: Frame) => Record<string, unknown> | undefined | null;
const MACHINES = ["pc2", "laptop"];

/** Host машины laptop с модулем parts; serve отвечает на запросы, ушедшие в relay. Журнал машины — поддельный модуль. */
async function bench(serve: Answer) {
  const p = make();
  const journal = module("host-journal", {
    requests: { "machine.journal": (req) => ({ records: [{ part: req.part, machine: "laptop" }], more: false }) },
    start() {},
    stop() {},
  }, { provides: { "machine.journal": 2 } });
  const st = await standHost({ modules: [{ manifest: manifest as Manifest, module: p.module }, journal] });
  stands.push(st);
  const recv = st.relay.receive.bind(st.relay);
  st.relay.receive = (ws, frame) => {
    recv(ws, frame);
    const f = JSON.parse(frame) as Frame;
    if (f.type === "hello" || f.type === "reply" || typeof f.id !== "string") return;
    // список машин — у gate; тест может ответить сам
    const got = serve(f);
    const r = got === null ? undefined : (got ?? (f.type === "keys.list" ? { ok: true, result: { passes: MACHINES.map((name) => ({ name })) } } : undefined));
    if (r) queueMicrotask(() => st.relay.deliver({ type: "reply", id: f.id as string, from: f.to ?? "x", ...r } as Frame));
  };
  const call = async (name: string, args: Record<string, unknown>, cwd = tmpdir(), extra: unknown = {}) => {
    const t = p.tools(cwd).find((x) => x.name === name)!;
    const r = (await t.handler(args as never, extra as never)) as { content: Array<{ text: string }>; isError?: boolean };
    return { ...r, text: r.content[0].text, json: () => JSON.parse(r.content[0].text) };
  };
  return { st, call, p };
}

const LISTED = {
  parts: { host: { where: "machine", edge: "1.1.58", stable: "1.1.57" }, capture: { where: "machine", edge: "1.5.0", stable: "1.4.0" } },
  machines: [
    { machine: "pc2", plan: { capture: { pin: "1.3.2" } } },
    { machine: "laptop", plan: {} },
  ],
  rev: 44,
};
const STATE = { keeper: "1.1.5", rev: 47, os: "linux", parts: [{ part: "host", version: "1.2.23", state: "running" }] };
const EIGHT = ["base1", "base2", "hz-ex44-1", "hz-ex44-2", "hz-ex44-win-1", "hz-win11", "rog-win-pro", "rog-wsl"];
const passes = (names: string[]) => ({ ok: true, result: { passes: names.map((name) => ({ name })) } });
const osModule = (version = "1.4.0") => {
  const dir = tmp("parts-app-");
  writeFileSync(join(dir, "app.json"), "{}");
  writeFileSync(join(dir, "module.json"), JSON.stringify({ name: "capture", type: "os", version, provides: {}, uses: {}, config: {} }));
  return dir;
};
const later = async (ms: number, go2: () => Promise<void>) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await go2();
    await vi.advanceTimersByTimeAsync(ms);
  } finally {
    vi.useRealTimers();
  }
};

describe("инструменты сессии parts", () => {
  it("сервер MCP сессии — parts с шестью инструментами; описания — контракт для модели", async () => {
    const st = await standHost({ modules: [{ manifest: manifest as Manifest, module: make().module }] });
    stands.push(st);
    await st.open("site@laptop");
    expect((st.query("site@laptop").options as { mcpServers: Record<string, unknown> }).mcpServers.parts).toMatchObject({ type: "sdk", name: "parts" });
    expect(make().tools("/").map((t) => t.name)).toEqual(["list", "upload", "fetch", "deploy", "set", "log"]);
    const about = Object.fromEntries(make().tools("/").map((t) => [t.name, t.description]));
    expect(about.list).toContain("error: timeout у машины значит: она не ответила, остальные верны, повтори вызов");
    expect(about.upload).toContain("Версия загружается один раз: тот же архив второй раз — same, другой — version_exists.");
    expect(about.fetch).toContain("Прежнее содержимое vendor/<part> заменяется.");
    expect(about.deploy).toContain("Откат — тот же вызов со старой версией.");
    expect(about.set).toContain("чистый перезапуск — on: false, затем on: true");
    expect(about.log).toContain("Host машины мёртв — причину даёт list (keeper.state).");
  });

  it("1 · list: каталог от .releases и состояние каждой машины от её keeper; закреплённая — с pin; keeper не ответил — error; part — только эта часть", async () => {
    const { st, call } = await bench((f) => {
      if (f.type === "releases.list") return { ok: true, result: LISTED };
      if (f.type === "keeper.state" && f.to === ".keeper@pc2")
        return { ok: true, result: { keeper: "0.6.0", rev: 44, os: "windows", parts: [{ part: "host", version: "1.1.57", state: "running" }, { part: "capture", version: "1.3.2", state: "running", pid: 9120 }] } };
      if (f.type === "keeper.state") return { ok: false, error: "offline" };
    });
    const r = await call("list", {});
    expect(r.isError).toBeUndefined();
    expect(r.json()).toEqual({
      parts: LISTED.parts,
      machines: [
        { machine: "pc2", keeper: "0.6.0", rev: 44, os: "windows", parts: [{ part: "host", version: "1.1.57", state: "running" }, { part: "capture", version: "1.3.2", state: "running", pid: 9120, pin: "1.3.2" }] },
        { machine: "laptop", error: "offline" },
      ],
    });
    const asked = st.relay.sent.filter((f) => f.id).map((f) => `${f.type} ${f.to}`);
    expect(asked[0]).toBe("keys.list .gate");
    expect(asked.slice(1).sort()).toEqual(["keeper.state .keeper@laptop", "keeper.state .keeper@pc2", "releases.list .releases"]);
    const one = await call("list", { part: "capture" });
    expect(one.json().machines[0].parts).toEqual([{ part: "capture", version: "1.3.2", state: "running", pid: 9120, pin: "1.3.2" }]);
    expect(st.relay.frames("releases.list").at(-1)).toMatchObject({ part: "capture" });
  });

  it.each<[string, Answer, string[], Record<string, unknown>]>([
    ["3073 · каталог отказал", (f) => (f.type === "releases.list" ? { ok: false, error: "no_access" } : f.type === "keeper.state" ? { ok: true, result: STATE } : undefined), MACHINES, { error: "каталог отказал (no_access): edge, stable и закрепления неизвестны" }],
    ["E25 · каталог молчит", (f) => (f.type === "keys.list" ? passes(EIGHT) : f.type === "keeper.state" ? { ok: true, result: STATE } : undefined), EIGHT, { error: "каталог не ответил за 10 с: edge, stable и закрепления неизвестны" }],
  ])("list без каталога: %s — { error, machines } без ключа частей", async (_n, serve, names, word) => {
    // источник: слово пользователя: «таймаутить нужно конкретную машину а не весь запрос и отдавать результат частично»;
    // находка архитектора: parts: { error } читалось бы как часть с именем error
    const { call } = await bench(serve);
    let r: Awaited<ReturnType<typeof call>>;
    await later(10_100, async () => void call("list", {}).then((x) => (r = x)));
    await vi.waitFor(() => expect(r).toBeDefined());
    expect(r!.isError).toBeUndefined();
    expect(r!.json()).toEqual({ ...word, machines: names.map((machine) => ({ machine, ...STATE })) });
  });

  it("E4 · 8 машин, одна молчит: 7 с данными, у одной error: timeout, ответ через 10 с после списка машин", async () => {
    // источник: слово пользователя: таймаутить конкретную машину
    const { call } = await bench((f) => {
      if (f.type === "keys.list") return passes(EIGHT);
      if (f.type === "releases.list") return { ok: true, result: { parts: LISTED.parts, machines: EIGHT.map((machine) => ({ machine, plan: {} })), rev: 47 } };
      if (f.type === "keeper.state" && f.to !== ".keeper@base1") return { ok: true, result: STATE };
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let done = false;
      const pending = call("list", {}).finally(() => (done = true));
      await vi.advanceTimersByTimeAsync(9_900);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      const got = (await pending).json();
      expect(got.parts).toEqual(LISTED.parts);
      expect(got.machines.find((m: { machine: string }) => m.machine === "base1")).toEqual({ machine: "base1", error: "timeout" });
      expect(got.machines.filter((m: { error?: string }) => !m.error)).toHaveLength(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it("E26 · служба пропусков молчит: через 10 с слово, каталог и keeper не спрашивали", async () => {
    // источник: устав: ошибка словом
    const { st, call } = await bench((f) => (f.type === "keys.list" ? null : { ok: true, result: {} }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = call("list", {});
      await vi.advanceTimersByTimeAsync(10_100);
      const r = await pending;
      expect([r.isError, r.text]).toEqual([true, "список машин неизвестен: keys.list — timeout"]);
      expect(st.relay.sent.filter((f) => f.type === "releases.list" || f.type === "keeper.state")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("2 · upload: модуль по module.json — две ссылки от «выпусков», архив и его хэш строкой sha256sum; без module.json — отказ без запроса", async () => {
    const dir = tmp("parts-app-");
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "app", "module.json"), JSON.stringify({ name: "capture", type: "os", version: "1.4.0", provides: {}, uses: {}, config: {} }));
    writeFileSync(join(dir, "app", "app.json"), '{ "run": ["node", "main.js"] }');
    writeFileSync(join(dir, "app", "main.js"), "process.stdin.resume();");
    const { st, call } = await bench((f) => (f.type === "releases.upload" ? { ok: true, result: { tgz: "https://r2.test/b/capture/1.4.0.tgz?sig", sha256: "https://r2.test/b/capture/1.4.0.sha256?sig" } } : undefined));
    const puts: Array<{ url: string; method?: string; body: Buffer }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
      puts.push({ url: String(u), method: init!.method, body: Buffer.from(init!.body as Uint8Array) });
      return new Response("", { status: 200 });
    });
    expect((await call("upload", { dir: "." }, dir)).text).toMatch(/^no_module_json/);
    expect(st.relay.sent.filter((f) => f.type === "releases.upload")).toEqual([]);
    const r = await call("upload", { dir: "app" }, dir);
    expect(r.isError).toBeUndefined();
    const hash = sha(puts[0].body);
    expect(r.json()).toEqual({ part: "capture", version: "1.4.0", bytes: puts[0].body.length, sha256: hash });
    expect(puts.map((p) => [p.method, p.url])).toEqual([["PUT", "https://r2.test/b/capture/1.4.0.tgz?sig"], ["PUT", "https://r2.test/b/capture/1.4.0.sha256?sig"]]);
    expect(puts[1].body.toString()).toBe(`${hash}  1.4.0.tgz\n`);
    // 5191 · одна упаковка «папка модуля → архив» у parts.upload и release-cli (отчёт слепого архитектора 2 нояб., пункт 12)
    expect(puts[0].body).toEqual(packModule(join(dir, "app")).tgz);
    expect(st.relay.sent.find((f) => f.type === "releases.upload")).toMatchObject({ to: ".releases", part: "capture", version: "1.4.0", sha256: hash });
  });

  it("5145 · upload: тот же архив уже лежит — «выпуски» отвечают same, PUT нет", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): загрузка по ссылкам «Выпусков» — одна функция у parts.upload и CI
    const { call } = await bench((f) => (f.type === "releases.upload" ? { ok: true, result: { same: true } } : undefined));
    const puts: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => (puts.push(String(url)), new Response("", { status: 200 })));
    expect((await call("upload", { dir: "." }, osModule())).json()).toMatchObject({ part: "capture", version: "1.4.0", same: true });
    expect(puts).toEqual([]);
  });

  it("5196 · 5195 · upload: номер занят архивом с тем же tar и другим сжатием — releases.fetch, сравнение без сжатия, same без PUT; другой tar — прежний отказ; ссылка не открылась — слово", async () => {
    // источник: живой факт 2 нояб.: gzip даёт разные байты на разных машинах при том же tar — «подними номер» на том же модуле
    const dir = osModule();
    const lying = gzipSync(gunzipSync(packModule(dir).tgz), { level: 1 });
    let look: Record<string, unknown> = { ok: true, result: { version: "1.4.0", url: "https://r2.test/capture/1.4.0.tgz?s" } };
    const { st, call } = await bench((f) => (f.type === "releases.upload" ? { ok: false, error: "version_exists" } : f.type === "releases.fetch" ? look : undefined));
    const seen: string[] = [];
    let body: Response = new Response(lying, { status: 200 });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => (seen.push(`${init?.method ?? "GET"} ${String(u)}`), body));
    expect((await call("upload", { dir: "." }, dir)).json()).toMatchObject({ part: "capture", version: "1.4.0", same: true });
    expect(seen).toEqual(["GET https://r2.test/capture/1.4.0.tgz?s"]);
    expect(st.relay.sent.filter((f) => f.type === "releases.fetch").map((f) => [f.part, f.version])).toEqual([["capture", "1.4.0"]]);
    body = new Response(new Uint8Array(pack([{ path: "module.json", data: Buffer.from("{}") }])), { status: 200 });
    const other = await call("upload", { dir: "." }, dir);
    expect([other.isError, other.text]).toEqual([true, "releases.upload: version_exists"]);
    body = new Response("", { status: 404 });
    const gone = await call("upload", { dir: "." }, dir);
    expect([gone.isError, gone.text]).toEqual([true, "fetch_failed: R2 ответил 404 на /capture/1.4.0.tgz"]);
    look = { ok: false, error: "no_release" };
    const none = await call("upload", { dir: "." }, dir);
    expect([none.isError, none.text]).toEqual([true, "releases.fetch: no_release"]);
  });

  it("3074 · upload: releases.upload отказал; R2 ответил 403 на архив — текст ошибки, хэш не пишется", async () => {
    // источник: чьё: код; версия готова, когда лежит хэш
    const dir = osModule();
    let refuse = true;
    const { call } = await bench((f) => (f.type === "releases.upload" ? (refuse ? { ok: false, error: "exists" } : { ok: true, result: { tgz: "https://r2.test/a.tgz?s", sha256: "https://r2.test/a.sha256?s" } }) : undefined));
    const a = await call("upload", { dir: "." }, dir);
    expect([a.isError, a.text]).toEqual([true, "releases.upload: exists"]);
    refuse = false;
    const puts: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => (puts.push(String(u)), new Response("", { status: 403 })));
    const b = await call("upload", { dir: "." }, dir);
    expect([b.isError, b.text]).toEqual([true, "upload_failed: R2 ответил 403 на /a.tgz"]);
    expect(puts).toEqual(["https://r2.test/a.tgz?s"]);
  });

  it("3152 · upload: R2 держит PUT и не отвечает — за 10 мин текст upload_failed с причиной, хэш не пишется", async () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»; предел — как у keeper на скачивание архива части
    const dir = osModule("1.4.2");
    const { call } = await bench((f) => (f.type === "releases.upload" ? { ok: true, result: { tgz: "https://r2.test/a.tgz?s", sha256: "https://r2.test/a.sha256?s" } } : undefined));
    const puts: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((u: RequestInfo | URL, init?: RequestInit) => {
      puts.push(String(u));
      return new Promise((_ok, no) => init?.signal?.addEventListener("abort", () => no(new Error("aborted"))));
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = call("upload", { dir: "." }, dir);
      await vi.waitFor(() => expect(puts).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      const r = await pending;
      expect([r.isError, r.text]).toEqual([true, "upload_failed: R2 не ответил за 10 мин на /a.tgz"]);
      expect(puts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("upload: сессия прервала ход — загрузка снята, хэш не пишется", async () => {
    // источник: комментарий старого кода «остановка вызывающего снимает его»; слово пользователя 2 нояб.: у всех операций лимит и graceful shutdown
    const { call } = await bench((f) => (f.type === "releases.upload" ? { ok: true, result: { tgz: "https://r2.test/a.tgz?s", sha256: "https://r2.test/a.sha256?s" } } : undefined));
    const puts: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((u: RequestInfo | URL, init?: RequestInit) => {
      puts.push(String(u));
      return new Promise((_ok, no) => init?.signal?.addEventListener("abort", () => no(new Error("aborted"))));
    });
    const ac = new AbortController();
    const stopped = call("upload", { dir: "." }, osModule("1.4.3"), { signal: ac.signal });
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    ac.abort();
    expect((await stopped).text).toBe("upload_failed: Error: aborted на /a.tgz");
    expect(puts).toHaveLength(1);
  });

  it("3 · 3075 · deploy и set — на .releases как есть, даже с полем machine; без версии — edge; pin null уходит как есть; отказ — словом и причиной", async () => {
    const { st, call } = await bench((f) => {
      if (f.type === "releases.deploy") return f.part === "*" ? { ok: false, error: "no_version", why: "нет" } : { ok: true, result: { parts: { host: { from: "1.1.58", to: "1.1.57" } } } };
      if (f.type === "releases.set") return f.part === "probe" ? { ok: false, error: "no_release" } : { ok: true, result: { machine: "wsl", rev: 45 } };
    });
    expect((await call("deploy", { part: "host", version: "1.1.57" })).json()).toEqual({ parts: { host: { from: "1.1.58", to: "1.1.57" } } });
    expect((await call("set", { machine: "wsl", part: "host", pin: "1.1.58" })).json()).toEqual({ machine: "wsl", rev: 45 });
    const no = await call("set", { machine: "wsl", part: "probe", on: true });
    expect([no.isError, no.text]).toEqual([true, "releases.set: no_release"]);
    const d = await call("deploy", { part: "*" });
    expect([d.isError, d.text]).toEqual([true, "releases.deploy: no_version — нет"]);
    await call("set", { machine: "wsl", part: "host", pin: null });
    expect(st.relay.sent.filter((f) => f.id && f.to === ".releases").map(({ id: _i, ...f }) => f)).toEqual([
      { type: "releases.deploy", v: 1, to: ".releases", part: "host", version: "1.1.57" },
      { type: "releases.set", v: 1, to: ".releases", machine: "wsl", part: "host", pin: "1.1.58" },
      { type: "releases.set", v: 1, to: ".releases", machine: "wsl", part: "probe", on: true },
      { type: "releases.deploy", v: 1, to: ".releases", part: "*" },
      { type: "releases.set", v: 1, to: ".releases", machine: "wsl", part: "host", pin: null },
    ]);
  });

  it("4 · 3076 · log: своя машина — журнал машины здесь, чужая — запрос её Host; по умолчанию — последний час и 50 строк; Host машины мёртв — текст ошибки", async () => {
    let dead = false;
    const { st, call } = await bench((f) => (f.type === "machine.journal" ? (dead ? { ok: false, error: "offline" } : { ok: true, result: { records: [{ part: f.part, machine: f.machine }], more: false } }) : undefined));
    expect((await call("log", { machine: "laptop", part: "capture", since: "2026-11-01T10:00:00Z" })).json()).toEqual({ records: [{ part: "capture", machine: "laptop" }], more: false });
    expect((await call("log", { machine: "win", part: "host", limit: 5 })).json()).toEqual({ records: [{ part: "host", machine: "win" }], more: false });
    expect(st.relay.sent.filter((f) => f.type === "machine.journal").map(({ id: _i, since: _s, ...f }) => f)).toEqual([{ type: "machine.journal", v: 2, machine: "win", part: "host", limit: 5 }]);
    dead = true;
    const before = Date.now();
    const r = await call("log", { machine: "win", part: "host" });
    expect([r.isError, r.text]).toEqual([true, "machine.journal: offline"]);
    const q = st.relay.frames("machine.journal").at(-1)!;
    expect(q).toMatchObject({ machine: "win", part: "host", limit: 50 });
    expect(Math.abs(before - Date.parse(q.since as string) - 3600_000)).toBeLessThanOrEqual(1000);
  });

  describe("fetch", () => {
    // источник всех эталонов блока: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): инструмент сессии кладёт контракт и стенд в vendor/ репо
    const tgz = pack([
      { path: "module.json", data: Buffer.from('{"name":"web-card","version":"1.1.0","type":"web"}') },
      { path: "contract.ts", data: Buffer.from("export {};\n") },
      { path: "stand/app.ts", data: Buffer.from("export const stand = 1;\n") },
    ]);

    it("5164 · ссылка от releases.fetch, архив — в <dir>/vendor/<part>/: module.json, контракт, стенд; прежнее содержимое заменено", async () => {
      const repo = tmp("parts-repo-");
      mkdirSync(join(repo, "vendor", "web-card"), { recursive: true });
      writeFileSync(join(repo, "vendor", "web-card", "old.ts"), "старое");
      const { st, call } = await bench((f) => (f.type === "releases.fetch" ? { ok: true, result: { version: "1.1.0", url: "https://r2.test/b/web-card/1.1.0.tgz?sig" } } : undefined));
      const got: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => (got.push(String(u)), new Response(new Uint8Array(tgz), { status: 200 })));
      const r = await call("fetch", { part: "web-card", dir: "." }, repo);
      expect(r.isError).toBeUndefined();
      expect(r.json()).toEqual({ part: "web-card", version: "1.1.0", dir: join(repo, "vendor", "web-card"), files: ["module.json", "contract.ts", "stand/app.ts"] });
      expect(got).toEqual(["https://r2.test/b/web-card/1.1.0.tgz?sig"]);
      expect(readFileSync(join(repo, "vendor", "web-card", "stand", "app.ts"), "utf8")).toBe("export const stand = 1;\n");
      expect(existsSync(join(repo, "vendor", "web-card", "old.ts"))).toBe(false);
      expect(st.relay.sent.find((f) => f.type === "releases.fetch")).toMatchObject({ to: ".releases", part: "web-card" });
    });

    it("5165 · releases.fetch отказал — текст ошибки, R2 не спрашивали; R2 ответил 404 — fetch_failed, vendor не тронут", async () => {
      const repo = tmp("parts-repo-");
      let answer: Record<string, unknown> = { ok: false, error: "no_release" };
      const { call } = await bench((f) => (f.type === "releases.fetch" ? answer : undefined));
      const got: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => (got.push(String(u)), new Response("", { status: 404 })));
      const a = await call("fetch", { part: "nobody", dir: "." }, repo);
      expect([a.isError, a.text]).toEqual([true, "releases.fetch: no_release"]);
      expect(got).toEqual([]);
      answer = { ok: true, result: { version: "1.0.0", url: "https://r2.test/x.tgz?s" } };
      const b = await call("fetch", { part: "x", version: "1.0.0", dir: "." }, repo);
      expect([b.isError, b.text]).toEqual([true, "fetch_failed: R2 ответил 404 на x 1.0.0"]);
      expect(existsSync(join(repo, "vendor"))).toBe(false);
    });

    it("5166 · R2 держит ответ — за 10 мин текст fetch_failed с причиной; сессия прервала ход — скачивание снято", async () => {
      // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»; предел — как у загрузки
      const repo = tmp("parts-repo-");
      const { call } = await bench((f) => (f.type === "releases.fetch" ? { ok: true, result: { version: "1.0.0", url: "https://r2.test/x.tgz?s" } } : undefined));
      const got: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation((u: RequestInfo | URL, init?: RequestInit) => {
        got.push(String(u));
        return new Promise((_ok, no) => init?.signal?.addEventListener("abort", () => no(new Error("aborted"))));
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const pending = call("fetch", { part: "x", dir: "." }, repo);
        await vi.waitFor(() => expect(got).toHaveLength(1));
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        const r = await pending;
        expect([r.isError, r.text]).toEqual([true, "fetch_failed: R2 не ответил за 10 мин на x 1.0.0"]);
      } finally {
        vi.useRealTimers();
      }
      const ac = new AbortController();
      const stopped = call("fetch", { part: "x", dir: "." }, repo, { signal: ac.signal });
      await vi.waitFor(() => expect(got).toHaveLength(2));
      ac.abort();
      expect((await stopped).text).toBe("fetch_failed: Error: aborted на x 1.0.0");
    });
  });
});

describe("сверка со старым кодом", () => {
  it("host --check упал без ответа-объекта — причина в отказе (чьё: код; вывод упавшего процесса — единственная причина)", async () => {
    const exec: Exec = async (cmd, args, cwd) => (cmd === "node" ? { code: 1, out: "Error: Cannot find module 'zod'\n    at main.ts:1\n" } : execOk()(cmd, args, cwd));
    await expect(main(["release", "core", "--dry-run", "--out", tmp()], {}, exec, go, fakeFleet().f)).rejects.toThrow("host --check: Error: Cannot find module 'zod'");
  }, 60_000);

  it("--out без значения — незнакомый аргумент: архив не уходит молча во временную папку (чьё: код)", async () => {
    await expect(main(["release", "core", "--dry-run", "--out"], {}, execOk(), go, fakeFleet().f)).rejects.toThrow("незнакомый аргумент: --out");
  });

  it("go build упал — временная папка сборки снята (чьё: код)", async () => {
    const own = tmp();
    for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, own);
    try {
      await expect(main(["release", "keeper", "--dry-run"], {}, execOk(), async () => ({ code: 1, out: "syntax error\n" }), fakeFleet().f)).rejects.toThrow("go build");
      expect(readdirSync(own)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("приложение ОС: app.json в корне, в dist/ его нет — архив из папки с app.json (чьё: код; описание инструмента: «dist/ с app.json или папка с app.json»)", () => {
    const d = tmp();
    mkdirSync(join(d, "dist"));
    writeFileSync(join(d, "module.json"), '{"name":"d3","type":"os","version":"1.0.0"}');
    writeFileSync(join(d, "app.json"), "{}");
    writeFileSync(join(d, "dist", "main.js"), "1");
    expect(files(packModule(d).tgz).map((e) => e.path)).toEqual(["module.json", "app.json"]);
  });
});
