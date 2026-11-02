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
    expect([...new Set(js.match(/from\s*"@switchboard\/[a-z-]+"/g))]).toEqual(['from"@switchboard/web-core"']);
    expect(js).not.toContain("@switchboard/protocol");
    expect(js).toContain("export");
    // ядро страницы само ничего внешнего не импортирует
    expect(text(packModule(join(root, "web/packages/core")).tgz, WEB_FILE)).not.toMatch(/from\s*"@switchboard\//);
    expect(packModule(join(root, "web/pult/modules/points")).sha).toBe(p.sha);
  });

  it("5132 · оболочка — module.json с именами Worker'а по флотам и статика без адресов relay, Worker'ов и модулей", async () => {
    // источник: дизайн «Открытый флот»: адресов relay в коде оболочек 0; имя Worker'а — из wrangler
    const p = packModule(join(root, "web/pult"));
    const paths = entries(p.tgz).map((e) => e.path);
    expect(paths[0]).toBe("module.json");
    expect(paths).toEqual(expect.arrayContaining(["index.html", "app.js", "sw.js", "manifest.webmanifest", "icon-192.png", "_headers"]));
    expect(paths.some((x) => x.startsWith("m/") || x === "build.json")).toBe(false);
    expect(await manifestOf(p.tgz)).toMatchObject({ name: "pult", type: "web-app", workers: { test: "switchboard-pult", prod: "switchboard-pult-prod" } });
    for (const f of ["index.html", "app.js", "sw.js"]) expect(text(p.tgz, f)).not.toMatch(/wss:\/\/|workers\.dev|pfarm\.app/);
  }, 60_000);

  it("5133 · сборка страницы: файлы оболочки в корне без module.json, m/<модуль>.js по списку, build.json; нет файла модуля — отказ с именем", () => {
    // источник: дизайн «Открытый флот»: «Выпуски» собирают версию Worker'а со статикой; сборщик только раскладывает
    const shell = pack([
      { path: "module.json", data: Buffer.from("{}") },
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
    expect(files.map((f) => f.path)).toEqual(["app.js", "index.html", "m/web-core.js", "m/web-board.js", "build.json"]);
    expect(files.find((f) => f.path === "m/web-board.js")!.data.toString()).toBe("// web-board");
    expect(JSON.parse(files.at(-1)!.data.toString())).toEqual(list);
    expect(() => webBuild(shell, [mod("web-core")], list)).toThrow("web-board: в архиве модуля нет module.js");
  });

  it("5180 · index.html сборки — с картой импорта модулей до первого скрипта: модульный скрипт домена (маячок Cloudflare) её не опередит", () => {
    // источник: прод 3 нояб. — на pult.pfarm.app маячок Web Analytics (модуль) грузился раньше карты, которую ставила оболочка:
    // «Failed to resolve module specifier '@switchboard/web-core'», страница не стартовала
    const html = '<!doctype html><html><head><meta charset="utf-8"><script src="app.js" defer></script></head><body></body></html>';
    const shell = pack([{ path: "index.html", data: Buffer.from(html) }, { path: "app.js", data: Buffer.from("boot()") }]);
    const mod = (name: string) => ({ name, tgz: pack([{ path: WEB_FILE, data: Buffer.from(`// ${name}`) }]) });
    const list: BuildList = { app: "pult", version: "1.2.1+1", fleet: "prod", modules: [{ name: "web-core", version: "1.3.2" }, { name: "web-board", version: "1.4.2" }], workers: {} };
    const out = webBuild(shell, [mod("web-core"), mod("web-board")], list).find((f) => f.path === "index.html")!.data.toString();
    const map = out.indexOf('<script type="importmap">');
    expect(map).toBeGreaterThan(0);
    expect(map).toBeLessThan(out.indexOf('<script src="app.js"'));
    expect(JSON.parse(out.slice(map + '<script type="importmap">'.length, out.indexOf("</script>", map)))).toEqual({
      imports: { "@switchboard/web-core": "./m/web-core.js", "@switchboard/web-board": "./m/web-board.js" },
    });
  });
});
