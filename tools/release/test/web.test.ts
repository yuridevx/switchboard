// Страница в каталоге: модуль страницы — одним файлом, оболочка — статикой без адресов; сборка — раскладка webBuild.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { manifestOf, pack, WEB_FILE, webBuild, type WebBuildList } from "../contract.ts";
import { packModule } from "../../release-cli/src/module.ts";
import { entries } from "../src/tar.ts";

const root = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const text = (tgz: Buffer, path: string) => entries(tgz).find((e) => e.path === path)!.data!.toString("utf8");

describe("страница в каталоге", () => {
  it("5131 · модуль страницы — module.json и один ES-файл: другие модули страницы — внешние импорты, протокол — внутри", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): «Веб: один файл ES-модуля»
    const p = packModule(join(root, "web/pult/modules/points"));
    expect(entries(p.tgz).map((e) => e.path)).toEqual(["module.json", WEB_FILE]);
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
    const list: WebBuildList = {
      app: "pult",
      version: "1.1.0+1",
      fleet: "test",
      modules: [
        { name: "web-core", version: "1.1.0" },
        { name: "web-board", version: "1.2.0" },
      ],
      relay: "wss://relay.test",
      workers: { gate: "https://gate.test/" },
    };
    const files = webBuild(shell, [mod("web-board"), mod("web-core")], list);
    expect(files.map((f) => f.path)).toEqual(["app.js", "index.html", "m/web-core.js", "m/web-board.js", "build.json"]);
    expect(files.find((f) => f.path === "m/web-board.js")!.data.toString()).toBe("// web-board");
    expect(JSON.parse(files.at(-1)!.data.toString())).toEqual(list);
    expect(() => webBuild(shell, [mod("web-core")], list)).toThrow("web-board: в архиве модуля нет module.js");
  });
});
