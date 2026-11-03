// Страница в каталоге: модуль страницы — одним файлом, оболочка — статикой без адресов; сборка — раскладка webBuild.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { manifestOf, pack, WEB_FILE, webBuild, type BuildList } from "../contract.ts";
import { packFromRepo as packModule } from "../../release-cli/src/module.ts";
import { entries } from "../src/tar.ts";

const root = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const text = (tgz: Buffer, path: string) => entries(tgz).find((e) => e.path === path)!.data!.toString("utf8");

describe("страница в каталоге", () => {
  it("5131 · 5167 · модуль страницы — module.json и один ES-файл (другие модули страницы — внешние импорты, протокол — внутри) и рядом папка пакета с контрактом и стендом", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): «Веб: один файл ES-модуля»
    const p = packModule(join(root, "web/pult/modules/points"));
    const paths = entries(p.tgz).map((e) => e.path);
    expect(paths[0]).toBe("module.json");
    expect(paths).toEqual(expect.arrayContaining([WEB_FILE, "contract.ts"]));
    expect(paths.some((x) => x.startsWith("test/"))).toBe(false);
    // ядро страницы отдаёт и стенд: чужой репо тестирует экраны на нём (5167)
    expect(entries(packModule(join(root, "web/packages/core")).tgz).map((e) => e.path)).toEqual(expect.arrayContaining(["stand/app.ts", "stand/relay.ts"]));
    expect(await manifestOf(p.tgz)).toMatchObject({ name: "pult-points", type: "web", into: ["pult"] });
    const js = text(p.tgz, WEB_FILE);
    // 5711: рантайм и набор внешние, ядро модуль не импортирует, копии рантайма в файле нет
    expect([...new Set(js.match(/from\s*"@switchboard\/[a-z-]+"/g))].sort()).toEqual(['from"@switchboard/web-ui"', 'from"@switchboard/web-view"']);
    expect(js).not.toContain("react.transitional.element");
    expect(js).not.toContain("@switchboard/protocol");
    expect(js).toContain("export");
    // ядро страницы импортирует только рантайм и набор
    expect([...new Set(text(packModule(join(root, "web/packages/core")).tgz, WEB_FILE).match(/from\s*"@switchboard\/[a-z-]+"/g))].sort()).toEqual(['from"@switchboard/web-ui"', 'from"@switchboard/web-view"']);
    expect(packModule(join(root, "web/pult/modules/points")).sha).toBe(p.sha);
  });

  it("5132 · оболочка — module.json с именами Worker'а по флотам и статика без адресов relay, Worker'ов и модулей", async () => {
    // источник: дизайн «Открытый флот»: адресов relay в коде оболочек 0; имя Worker'а — из wrangler
    const p = packModule(join(root, "web/pult"));
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

  it("5133 · сборка страницы: файлы оболочки в корне без module.json, m/<модуль>.js по списку, build.json; нет файла модуля — отказ с именем", () => {
    // источник: дизайн «Открытый флот»: «Выпуски» собирают версию Worker'а со статикой; сборщик только раскладывает
    const shell = pack([
      { path: "module.json", data: Buffer.from(JSON.stringify({ version: "1.1.0" })) },
      { path: "index.html", data: Buffer.from("<html>") },
      { path: "app.js", data: Buffer.from("boot()") },
    ]);
    const mod = (name: string) => ({ name, tgz: pack([{ path: "module.json", data: Buffer.from("{}") }, { path: WEB_FILE, data: Buffer.from(`// ${name}`) }]) });
    const list: BuildList = {
      app: "pult",
      version: "1.1.0+1",
      fleet: "test",
      modules: [
        { name: "web-core", version: "1.1.0" },
        { name: "web-board", version: "1.2.0" },
      ],
      workers: { gate: "https://gate.test/", relay: "https://relay.test/" },
    };
    const files = webBuild(shell, [mod("web-board"), mod("web-core")], list);
    expect(files.map((f) => f.path)).toEqual(["app.1.1.0.js", "index.html", "m/web-core.1.1.0.js", "m/web-board.1.2.0.js", "_headers", "build.json"]);
    expect(files.find((f) => f.path === "m/web-board.1.2.0.js")!.data.toString()).toBe("// web-board");
    expect(JSON.parse(files.at(-1)!.data.toString())).toEqual(list);
    expect(() => webBuild(shell, [mod("web-core")], list)).toThrow("web-board: в архиве модуля нет module.js");
  });

  it("5712 · сборка страницы: версии в именах модулей и оболочки, modulepreload на каждый модуль, одно правило вечного кэша", () => {
    // источник: дизайн «Новая модульность фронта», опыт: запросов при повторном запуске 6 → 1; каталог принимает версию один раз
    const shell = pack([{ path: "module.json", data: Buffer.from(JSON.stringify({ version: "1.3.0" })) }, { path: "index.html", data: Buffer.from('<!doctype html><head><script src="app.js" defer></script></head>') }, { path: "app.js", data: Buffer.from("boot()") }]);
    const mod = (name: string) => ({ name, tgz: pack([{ path: WEB_FILE, data: Buffer.from(`// ${name}`) }]) });
    const list: BuildList = { app: "pult", version: "1.3.0+1", fleet: "test", modules: [{ name: "web-view", version: "19.3.1" }, { name: "web-chat", version: "2.0.0" }], workers: {} };
    const files = webBuild(shell, [mod("web-view"), mod("web-chat")], list);
    const html = files.find((f) => f.path === "index.html")!.data.toString();
    expect(html).toContain('<link rel="modulepreload" href="./m/web-view.19.3.1.js">');
    expect(html).toContain('<link rel="modulepreload" href="./m/web-chat.2.0.0.js">');
    expect(html).toContain('src="app.1.3.0.js"');
    expect(html.indexOf('type="importmap"')).toBeLessThan(html.indexOf("modulepreload"));
    expect(files.find((f) => f.path === "_headers")!.data.toString()).toBe("/m/*\n  Cache-Control: public, max-age=31536000, immutable\n/app.*.js\n  Cache-Control: public, max-age=31536000, immutable\n");
  });

  it("5180 · index.html сборки — с картой импорта модулей до первого скрипта: модульный скрипт домена (маячок Cloudflare) её не опередит", () => {
    // источник: прод 3 нояб. — на pult.pfarm.app маячок Web Analytics (модуль) грузился раньше карты, которую ставила оболочка:
    // «Failed to resolve module specifier '@switchboard/web-core'», страница не стартовала
    const html = '<!doctype html><html><head><meta charset="utf-8"><script src="app.js" defer></script></head><body></body></html>';
    const shell = pack([{ path: "module.json", data: Buffer.from(JSON.stringify({ version: "1.2.1" })) }, { path: "index.html", data: Buffer.from(html) }, { path: "app.js", data: Buffer.from("boot()") }]);
    const mod = (name: string) => ({ name, tgz: pack([{ path: WEB_FILE, data: Buffer.from(`// ${name}`) }]) });
    const list: BuildList = { app: "pult", version: "1.2.1+1", fleet: "prod", modules: [{ name: "web-core", version: "1.3.2" }, { name: "web-board", version: "1.4.2" }], workers: {} };
    const out = webBuild(shell, [mod("web-core"), mod("web-board")], list).find((f) => f.path === "index.html")!.data.toString();
    const map = out.indexOf('<script type="importmap">');
    expect(map).toBeGreaterThan(0);
    expect(map).toBeLessThan(out.indexOf('<script src="app.1.2.1.js"'));
    expect(JSON.parse(out.slice(map + '<script type="importmap">'.length, out.indexOf("</script>", map)))).toEqual({
      imports: { "@switchboard/web-core": "./m/web-core.1.3.2.js", "@switchboard/web-board": "./m/web-board.1.4.2.js" },
    });
  });
});
