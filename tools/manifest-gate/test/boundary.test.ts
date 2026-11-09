// Леса гейта манифестов. Вход — контракт и `npm run gate`, исход — слова нарушений, порядок сборки, манифесты с импортами, код выхода.
// Номер — эталон-источник; без номера — чьё: код.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { check, checkSet, loadRepo, nameOf, order, ownerOf, type Manifest } from "../contract.ts";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "..");

const m = (name: string, x: Partial<Manifest> = {}): Manifest => ({
  name, type: "worker", version: "1.0.0", provides: {}, uses: {}, config: {}, pkg: `@switchboard/${name}`, imports: [], ...x,
});

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

type Files = Record<string, string | Record<string, unknown>>;
/** Временный монорепо: путь → текст или объект JSON. */
function repo(files: Files): string {
  const root = mkdtempSync(join(tmpdir(), "manifest-gate-"));
  roots.push(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof body === "string" ? body : JSON.stringify(body));
  }
  return root;
}
const mod = (name: string, x: Record<string, unknown> = {}) => ({ name, type: "worker", version: "1.0.0", provides: {}, uses: {}, config: {}, ...x });
const gate = (files: Files) => check(loadRepo(repo(files)));
/** Прогон настоящего `cli.ts` на временном монорепо; своих node_modules у него нет, инструменты — из настоящего корня. */
function gateOn(root: string) {
  cpSync(GATE, join(root, "tools", "manifest-gate"), { recursive: true });
  return spawnSync(process.execPath, [join(root, "tools", "manifest-gate", "cli.ts")], { encoding: "utf8", env: { ...process.env, NODE_PATH: join(GATE, "..", "..", "node_modules") } });
}

describe("набор модулей", () => {
  it("2074 · годный набор — без нарушений: protocol и свой пакет без uses — не нарушение", () => {
    const set = [
      m("gate", { provides: { "gate.verify": 1 }, config: { FLEET_SECRET: "secret" } }),
      m("relay", { provides: { hello: 1 }, uses: { "gate.verify@gate": 1 }, imports: ["@switchboard/gate", "@switchboard/protocol", "@switchboard/relay/src/link.ts"] }),
    ];
    expect(check(set)).toEqual([]);
  });

  it.each<[string, Manifest[], string[]]>([
    ["140 · два владельца у имени", [m("host-push", { provides: { notify: 1 } }), m("budget", { provides: { notify: 1 } })], ["имя notify: два владельца — host-push и budget"]],
    [
      "141 · uses другой версии, без владельца, без формы имя@владелец",
      [m("push", { provides: { "push.send": 1 } }), m("host-push", { uses: { "push.send@push": 2, "x@nobody": 1, bad: 1 } })],
      ["модуль host-push: uses push.send@push v2 — у владельца v1", "модуль host-push: uses x@nobody — владельца нет в наборе", "модуль host-push: uses «bad» — нужно имя@владелец"],
    ],
    ["142 · импорт мимо uses", [m("host-push", { provides: { notify: 1 } }), m("watch", { imports: ["@switchboard/host-push"] })], ["модуль watch: импорт @switchboard/host-push — host-push нет в uses"]],
    [
      "142 · глубокий импорт мимо контракта при объявленном uses",
      [m("host-push", { provides: { notify: 1 } }), m("watch", { uses: { "notify@host-push": 1 }, imports: ["@switchboard/host-push/src/send.ts"] })],
      ["модуль watch: импорт @switchboard/host-push/src/send.ts — мимо контракта @switchboard/host-push"],
    ],
    [
      "2075 · импорт модуля, которого нет; uses на имя, которого владелец не отдаёт",
      [m("push", { provides: { "push.send": 1 } }), m("watch", { uses: { "push.key@push": 1 }, imports: ["@switchboard/ghost"] })],
      ["модуль watch: uses push.key@push — push не отдаёт push.key", "модуль watch: импорт @switchboard/ghost — такого модуля нет"],
    ],
    [
      "хранилище модулем: две реализации контракта blocks, points зовёт имя контракта — годно",
      [
        m("blocks", { type: "contract", provides: { "blocks.links": 1 } }),
        m("blocks-r2", { implements: "blocks", imports: ["@switchboard/blocks"], config: { BUCKET: "binding" } }),
        m("blocks-ch", { implements: "blocks", imports: ["@switchboard/blocks"] }),
        m("points", { uses: { "blocks.links@blocks": 1 } }),
      ],
      [],
    ],
    [
      "реализация: своё имя, не контракт, код без контракта; у контракта config",
      [
        m("blocks", { type: "contract", provides: { "blocks.links": 1 }, config: { X: "var" } }),
        m("relay", { provides: { hello: 1 } }),
        m("blocks-r2", { implements: "blocks", provides: { "blocks.mine": 1 }, imports: ["@switchboard/blocks"] }),
        m("blocks-ch", { implements: "blocks" }),
        m("blocks-kv", { implements: "relay", imports: ["@switchboard/relay"] }),
      ],
      [
        "модуль blocks: у модуля-контракта нет config, uses и implements",
        "модуль blocks-r2: implements blocks — своих provides у реализации нет",
        "модуль blocks-ch: implements blocks — код не берёт контракт @switchboard/blocks",
        "модуль blocks-kv: implements relay — не модуль-контракт",
      ],
    ],
    ["повтор имени модуля", [m("relay"), m("relay")], ["модуль relay: имя уже занято"]],
    ["секрет в двух модулях; не секрет — можно", [m("gate", { config: { S: "secret", V: "var" } }), m("relay", { config: { S: "secret", V: "var" } })], ["секрет S: в config двух модулей — gate и relay"]],
  ])("%s", (_n, set, want) => {
    expect(check(set)).toEqual(want);
  });

  it("5111 · into называет корень сборки своего типа: модуль Host — в ядро, экран — в оболочку страницы; у Worker into нет", () => {
    const set = [m("host", { type: "sdk-core" }), m("pult", { type: "web-app" }), m("host-chat", { type: "sdk", into: ["host"] }), m("pult-open", { type: "web", into: ["pult"] })];
    expect(check(set)).toEqual([]);
    expect(check([...set, m("host-x", { type: "sdk", into: ["pult"] }), m("web-x", { type: "web", into: ["phone"] }), m("push", { into: ["host"] })])).toEqual([
      "модуль host-x: into pult — pult не sdk-core",
      "модуль web-x: into phone — такого приложения нет в наборе",
      "модуль push: into у типа worker не бывает",
    ]);
  });

  it("5114 · список сборки — в порядке зависимостей: владелец раньше, из готовых первым по имени; check ловит цикл в любом порядке", () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): список сборки — зависимость раньше
    const watch = m("host-watch", { type: "sdk", provides: { "session.watchers": 1 } });
    const push = m("host-push", { type: "sdk", provides: { notify: 1 }, uses: { "session.watchers@host-watch": 1 } });
    const q = m("host-questions", { type: "sdk", uses: { "notify@host-push": 1, "session.watchers@host-watch": 1 } });
    expect(order([q, push, watch]).map((x) => x.name)).toEqual(["host-watch", "host-push", "host-questions"]);
    expect(order([m("b"), m("a"), m("c", { uses: { "x@outside": 1 } })]).map((x) => x.name)).toEqual(["a", "b", "c"]);
    expect(check([q, watch, push])).toEqual([]);
    const a1 = m("a", { provides: { x: 1 }, uses: { "y@b": 1 } });
    const b1 = m("b", { provides: { y: 1 }, uses: { "z@c": 1 } });
    const c1 = m("c", { provides: { z: 1 }, uses: { "x@a": 1 } });
    expect(check([c1, b1, a1, watch])).toEqual(["цикл зависимостей: c → a → b → c"]);
    expect(order([c1, a1, b1]).map((x) => x.name).sort()).toEqual(["a", "b", "c"]);
    expect(check([m("a", { provides: { x: 1 }, uses: { "x@a": 1 } })])).toEqual([]);
  });

  it("7901 · checkSet судит набор сам по себе: ссылка на владельца вне набора отброшена, ссылка внутри и остальные поля манифеста идут к check", () => {
    // источник: чьё: код — отбор из setProblems Host и appGate страницы, сведён к владельцу вердиктом архитектора 6 нояб.
    const owner = m("o", { provides: { x: 1 } });
    const user = m("a", { uses: { "x@o": 1, "y@outside": 1, bad: 1 } });
    expect(check([owner, user])).toEqual(["модуль a: uses y@outside — владельца нет в наборе", "модуль a: uses «bad» — нужно имя@владелец"]);
    expect(checkSet([owner, user])).toEqual([]);
    expect(user.uses).toEqual({ "x@o": 1, "y@outside": 1, bad: 1 });
    expect(checkSet([owner, m("a", { uses: { "x@o": 2, "y@outside": 1 } })])).toEqual(["модуль a: uses x@o v2 — у владельца v1"]);
    expect(checkSet([m("a", { type: "web", into: ["pult"], imports: ["@switchboard/ghost"] })])).toEqual(["модуль a: импорт @switchboard/ghost — такого модуля нет", "модуль a: into pult — такого приложения нет в наборе"]);
  });

  it("ссылка манифеста: имя и владелец по последней @", () => {
    expect([nameOf("gate.verify@gate"), ownerOf("gate.verify@gate")]).toEqual(["gate.verify", "gate"]);
    expect([nameOf("a@b@c"), ownerOf("a@b@c")]).toEqual(["a@b", "c"]);
    expect([nameOf("bad"), ownerOf("bad")]).toEqual(["bad", ""]);
  });
});

describe("монорепо", () => {
  it("манифесты всех групп с умолчаниями, пакетом и папкой — в порядке зависимостей; манифест остаётся как в файле", () => {
    const root = repo({
      "protocol/module.json": mod("protocol"),
      "protocol/package.json": { name: "@switchboard/protocol" },
      "tools/t/module.json": mod("t", { uses: { "x@w": 1 } }),
      "workers/w/module.json": { name: "w", type: "worker", version: "1.0.0", provides: { x: 1 } },
      "workers/none/readme.md": "нет манифеста",
      "os/k/module.json": mod("k"),
      "host/core/module.json": mod("host"),
      "host/modules/a/module.json": mod("host-a", { into: ["host"], calls: ["setModel"] }),
      "web/packages/p/module.json": mod("web-p"),
      "web/phone/module.json": mod("phone"),
      "web/phone/modules/s/module.json": mod("phone-s"),
      "web/pult/module.json": mod("pult"),
      "web/pult/modules/s/module.json": mod("pult-s"),
      "scripts/module.json": mod("not-a-module"),
    });
    const mods = loadRepo(root) as (Manifest & { dir: string; calls?: string[] })[];
    expect(mods.map((x) => x.name).sort()).toEqual(["host", "host-a", "k", "phone", "phone-s", "protocol", "pult", "pult-s", "t", "w", "web-p"]);
    expect(mods.findIndex((x) => x.name === "w")).toBeLessThan(mods.findIndex((x) => x.name === "t"));
    const w = mods.find((x) => x.name === "w")!;
    expect([w.uses, w.config, w.imports, w.pkg]).toEqual([{}, {}, [], undefined]);
    expect(w.dir.replaceAll("\\", "/")).toBe("workers/w");
    expect(mods.find((x) => x.name === "protocol")!.pkg).toBe("@switchboard/protocol");
    expect(mods.find((x) => x.name === "pult-s")!.dir.replaceAll("\\", "/")).toBe("web/pult/modules/s");
    expect(mods.find((x) => x.name === "host-a")!.into).toEqual(["host"]);
    expect(mods.find((x) => x.name === "host-a")!.calls).toEqual(["setModel"]);
  });

  it.each<[string, string, string, string[]]>([
    ["import from и многострочный", "a.ts", 'import { x } from "@switchboard/from";\nimport {\n  a,\n  b,\n} from "@switchboard/multi";\n', ["@switchboard/from", "@switchboard/multi"]],
    ["import()", "a.ts", 'const d = () => import("@switchboard/dynamic");\n', ["@switchboard/dynamic"]],
    ["import() в типе", "a.ts", 'type T = import("@switchboard/type-of").T;\n', ["@switchboard/type-of"]],
    ["require", "a.ts", 'const r = require("@switchboard/req");\n', ["@switchboard/req"]],
    ["файл .tsx, React — рантайм страницы", "b.tsx", 'import { useState } from "react";\n', ["@switchboard/web-view"]],
    ["файл .d.ts не считается", "skip.d.ts", 'import "@switchboard/dts";\n', []],
    ["папка dist не считается", "dist/s.js", 'import "@switchboard/x";\n', []],
    ["глубокая папка test не считается", "src/deep/test/t.ts", 'import "@switchboard/x";\n', []],
    ["node_modules не считается", "node_modules/n/i.js", 'import "@switchboard/x";\n', []],
    ["импорт в комментарии — не импорт (устав: устройство кода, а не текст)", "a.ts", '// import "@switchboard/line";\n/* import { x } from "@switchboard/block"; */\n/**\n * import "@switchboard/doc";\n */\n', []],
    ["импорт в строке — не импорт (устав: устройство кода, а не текст)", "a.ts", 'const s = \'import "@switchboard/str"\';\nconst t = `import { x } from "@switchboard/tpl";`;\nconst b = \'import "react"\';\nconst r = "react";\n', []],
  ])("импорты кода: %s", (_n, path, text, imports) => {
    const mods = loadRepo(repo({ "web/packages/a/module.json": mod("a"), [`web/packages/a/${path}`]: text }));
    expect(mods[0].imports).toEqual(imports);
  });

  it("вложенный модуль считает свой код сам", () => {
    const mods = loadRepo(repo({ "web/pult/module.json": mod("pult"), "web/pult/modules/s/module.json": mod("pult-s"), "web/pult/modules/s/i.ts": 'import "@switchboard/nested";\n' }));
    expect(mods.find((x) => x.name === "pult")!.imports).toEqual([]);
    expect(mods.find((x) => x.name === "pult-s")!.imports).toEqual(["@switchboard/nested"]);
  });

  it("манифесты читаются без разбора кода: факты — при первом чтении, release-cli и стендам нужны только манифесты", () => {
    const [w] = loadRepo(repo({ "workers/w/module.json": mod("w"), "workers/w/a.ts/keep.txt": "папка с именем файла кода: прочесть её нельзя" }));
    expect(w.name).toBe("w");
    expect(() => w.imports).toThrow();
  });

  it("2073 · npm run gate на настоящем монорепо: выход 0 и строка с числами", () => {
    const r = spawnSync(process.execPath, [join(GATE, "cli.ts")], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toMatch(/^gate: ok · \d+ модулей · \d+ имён контракта$/);
  });

  it("npm run gate: нарушение — выход 1 и причины; годный набор считает модули и имена", () => {
    const bad = gateOn(repo({ "workers/a/module.json": mod("a", { uses: { "x@b": 1 } }), "workers/b/module.json": mod("b", { provides: { y: 1 } }) }));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("gate: 1 нарушений\nмодуль a: uses x@b — b не отдаёт x");
    const good = gateOn(repo({ "workers/a/module.json": mod("a", { provides: { x: 1, y: 1 } }), "workers/b/module.json": mod("b", { provides: { z: 1 } }) }));
    expect(good.status).toBe(0);
    // в счёте и сам гейт: скопирован во временный монорепо вместе с cli
    expect(good.stdout.trim()).toBe("gate: ok · 3 модулей · 4 имён контракта");
  });

  it("контракт собирается для браузера: check идёт на странице, Node и файловая система ему не нужны", async () => {
    const out = await build({ entryPoints: [join(GATE, "contract.ts")], bundle: true, platform: "browser", format: "iife", globalName: "gate", write: false, logLevel: "silent" });
    const page = runInNewContext(`${out.outputFiles[0].text};gate`) as { check: typeof check };
    expect([...page.check([m("a", { uses: { bad: 1 } })])]).toEqual(["модуль a: uses «bad» — нужно имя@владелец"]);
  });
});

describe("устройство кода против манифеста", () => {
  const owner = mod("gate", { provides: { "gate.verify": 1, "gate.revoked": 1, "keys.list": 1 } });
  const CALL = ["модуль own: зовёт gate.revoked — нет в uses"];

  // источник: факт 5 нояб., workers/push зовёт gate.revoked при uses только gate.verify
  it.each<[string, string, string, Record<string, number>, string[]]>([
    ["имя без uses; чужое имя и база — не контракт", "src/a.ts", "export const f = (env) => { env.GATE.verify(1); env.GATE.revoked([]); env.GATE.zzz(); env.DB.prepare(''); };\n", { "gate.verify@gate": 1 }, CALL],
    ["своё имя", "src/a.ts", "export const f = (env) => env.OWN.key();\n", {}, []],
    ["имя строчными — поле объекта, а не привязка", "src/a.ts", "const f = (env) => env.gate.revoked([]);\n", {}, []],
    ["this.env", "src/a.ts", "class A { f() { this.env.GATE.revoked([]); } }\n", {}, CALL],
    ["в строке и комментарии — не вызов (устав: устройство кода, а не текст)", "src/a.ts", '// env.GATE.revoked([]);\nconst s = "env.GATE.revoked([])";\n', {}, []],
  ])("вызов привязки Worker: %s", (_n, path, code, uses, want) => {
    expect(gate({ "workers/gate/module.json": owner, "workers/own/module.json": mod("own", { provides: { "own.key": 1 }, uses }), [`workers/own/${path}`]: code })).toEqual(want);
  });

  // источник: дизайн «Прокси модели», шаг 7 — tool только у запроса с типом, который есть в контракте
  it.each<[string, Record<string, unknown>, string[]]>([
    ["запрос с типом из контракта", { "own.key": { about: "ключ", type: "OwnKey" } }, []],
    ["запроса нет в provides", { "own.nope": { about: "x", type: "OwnKey" } }, ["модуль own: tool у own.nope — такого запроса в provides нет"]],
    ["типа нет в contract.ts", { "own.key": { about: "x", type: "Nope" } }, ["модуль own: tool у own.key — типа Nope нет в contract.ts"]],
    ["без описания", { "own.key": { about: "", type: "OwnKey" } }, ["модуль own: tool у own.key — нужны about и type"]],
  ])("инструмент MCP в манифесте: %s", (_n, tools, want) => {
    expect(gate({ "workers/own/module.json": mod("own", { provides: { "own.key": 1 }, tools }), "workers/own/contract.ts": "export type OwnKey = { name: string };\nexport interface Other {}\n" })).toEqual(want);
  });

  const packages: Files = {
    "web/packages/a/module.json": mod("a"),
    "web/packages/a/package.json": { name: "@switchboard/a" },
    "web/packages/b/module.json": mod("b", { provides: { t: 1 } }),
    "web/packages/b/package.json": { name: "@switchboard/b" },
    "web/packages/b/contract.ts": "export {};\n",
    "web/packages/c/module.json": mod("c", { uses: { "t@b": 1 } }),
  };

  it.each<[string, Files, string]>([
    ["код идёт в чужой контракт без uses", { "web/packages/a/src/x.ts": 'import type { T } from "../../b/contract.ts";\n' }, "модуль a: импорт b/contract.ts — b нет в uses"],
    ["код идёт в чужой контракт, имя объявлено, но внутрь", { "web/packages/c/src/x.ts": 'import { t } from "../../b/src/in.ts";\n' }, "модуль c: импорт b/src/in.ts — мимо контракта b"],
    ["тест рядом с кодом идёт во внутренности чужого модуля", { "web/packages/a/src/x.spec.ts": 'import { t } from "../../b/src/in.ts";\n' }, "модуль a: тест импортирует b/src/in.ts — мимо контракта b"],
    ["стенд идёт во внутренности чужого модуля", { "web/packages/a/stand/x.ts": 'import { t } from "../../b/src/in.ts";\n' }, "модуль a: тест импортирует b/src/in.ts — мимо контракта b"],
    ["тест идёт во внутренности чужого пакета", { "web/packages/a/test/x.test.ts": 'import { t } from "@switchboard/b/src/in.ts";\n' }, "модуль a: тест импортирует b/src/in.ts — мимо контракта b"],
  ])("относительный путь считается импортом модуля: %s", (_n, files, want) => {
    expect(gate({ ...packages, ...files })).toEqual([want]);
  });

  it("относительный импорт в комментарии и строке — не импорт (устав: устройство кода, а не текст)", () => {
    expect(gate({ ...packages, "web/packages/a/src/x.ts": '// import "../../b/src/in.ts";\nconst s = \'import "../../b/src/in.ts"\';\n' })).toEqual([]);
  });

  it("можно: свой файл, чужой контракт из uses; тесту — контракт, манифест и стенд чужого модуля без uses; у модуля без контракта правила для тестов нет", () => {
    expect(
      gate({
        "web/packages/a/module.json": mod("a", { uses: { "t@b": 1 } }),
        "web/packages/a/src/x.ts": 'import { y } from "./y.ts";\nimport type { T } from "../../b/contract.ts";\n',
        "web/packages/a/src/y.ts": "export const y = 1;\n",
        "web/packages/b/module.json": mod("b", { provides: { t: 1 } }),
        "web/packages/b/contract.ts": "export {};\n",
        "web/packages/b/stand/s.ts": "export {};\n",
        "web/packages/c/module.json": mod("c"),
        "web/packages/c/test/x.test.ts": 'import "../../b/contract.ts";\nimport m from "../../b/module.json";\nimport "../../b/stand/s.ts";\nimport "../../../tools/open/src/in.ts";\n',
        "tools/open/module.json": mod("open"),
        "tools/open/src/in.ts": "export {};\n",
        "scripts/x.ts": 'import "../web/packages/b/src/in.ts";\n',
      }),
    ).toEqual([]);
  });
});
