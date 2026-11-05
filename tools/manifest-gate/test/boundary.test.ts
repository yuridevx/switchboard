// Леса гейта манифестов. Вход — контракт и `npm run gate`, исход — слова нарушений, порядок сборки, манифесты с импортами, код выхода.
// Номер — эталон-источник; без номера — чьё: код.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { check, loadRepo, nameOf, order, ownerOf, type Manifest } from "../contract.ts";

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
/** Прогон настоящего `cli.ts` на временном монорепо. */
function gateOn(root: string) {
  cpSync(GATE, join(root, "tools", "manifest-gate"), { recursive: true });
  return spawnSync(process.execPath, [join(root, "tools", "manifest-gate", "cli.ts")], { encoding: "utf8" });
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
    ["uses с пустым именем", [m("a", { uses: { "@b": 1 } }), m("b")], ["модуль a: uses «@b» — нужно имя@владелец"]],
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
    ["глубокий импорт протокола — не исключение", [m("protocol", { pkg: "@switchboard/protocol" }), m("a", { imports: ["@switchboard/protocol/src/x.ts"] })], ["модуль a: импорт @switchboard/protocol/src/x.ts — protocol нет в uses"]],
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
  });

  it("ссылка манифеста: имя и владелец по последней @", () => {
    expect([nameOf("gate.verify@gate"), ownerOf("gate.verify@gate")]).toEqual(["gate.verify", "gate"]);
    expect([nameOf("a@b@c"), ownerOf("a@b@c")]).toEqual(["a@b", "c"]);
  });
});

describe("монорепо", () => {
  it("манифесты всех групп с умолчаниями, пакетом и папкой — в порядке зависимостей", () => {
    const root = repo({
      "protocol/module.json": mod("protocol"),
      "protocol/package.json": { name: "@switchboard/protocol" },
      "tools/t/module.json": mod("t", { uses: { "x@w": 1 } }),
      "workers/w/module.json": { name: "w", type: "worker", version: "1.0.0", provides: { x: 1 } },
      "workers/none/readme.md": "нет манифеста",
      "os/k/module.json": mod("k"),
      "host/core/module.json": mod("host"),
      "host/modules/a/module.json": mod("host-a"),
      "web/packages/p/module.json": mod("web-p"),
      "web/phone/module.json": mod("phone"),
      "web/pult/module.json": mod("pult"),
      "web/pult/modules/s/module.json": mod("pult-s"),
      "scripts/module.json": mod("not-a-module"),
    });
    const mods = loadRepo(root);
    expect(mods.map((x) => x.name).sort()).toEqual(["host", "host-a", "k", "phone", "protocol", "pult", "pult-s", "t", "w", "web-p"]);
    expect(mods.findIndex((x) => x.name === "w")).toBeLessThan(mods.findIndex((x) => x.name === "t"));
    const w = mods.find((x) => x.name === "w")!;
    expect([w.uses, w.config, w.imports, w.pkg]).toEqual([{}, {}, [], undefined]);
    expect(w.dir.replaceAll("\\", "/")).toBe("workers/w");
    expect(mods.find((x) => x.name === "protocol")!.pkg).toBe("@switchboard/protocol");
    expect(mods.find((x) => x.name === "pult-s")!.dir.replaceAll("\\", "/")).toBe("web/pult/modules/s");
  });

  it("импорты кода: все формы; тесты, стенд, типы, чужие пакеты и вложенный модуль не считаются; React — это рантайм страницы", () => {
    const root = repo({
      "web/pult/module.json": mod("pult"),
      "web/pult/a.ts": 'import { x } from "@switchboard/from";\nimport type { Y } from "@switchboard/type/deep.ts";\nexport { z } from "@switchboard/export";\nimport "@switchboard/side";\nconst d = () => import("@switchboard/dynamic");\nimport l from "lodash";\n',
      "web/pult/src/b.tsx": 'import { useState } from "react";\n',
      "web/pult/src/c.mjs": 'import "@switchboard/mjs";\n',
      "web/pult/src/d.mts": 'import "@switchboard/mts";\n',
      "web/pult/src/e.js": 'import "@switchboard/js";\n',
      "web/pult/src/skip.test.ts": 'import "@switchboard/test-file";\n',
      "web/pult/src/skip.spec.ts": 'import "@switchboard/spec-file";\n',
      "web/pult/src/skip.d.ts": 'import "@switchboard/dts";\n',
      "web/pult/src/skip.css": '@import "@switchboard/css";\n',
      "web/pult/test/t.ts": 'import "@switchboard/test-dir";\n',
      "web/pult/tests/t.ts": 'import "@switchboard/tests-dir";\n',
      "web/pult/stand/s.ts": 'import "@switchboard/stand-dir";\n',
      "web/pult/dist/s.js": 'import "@switchboard/dist-dir";\n',
      "web/pult/node_modules/n/i.js": 'import "@switchboard/nm";\n',
      "web/pult/modules/s/module.json": mod("pult-s"),
      "web/pult/modules/s/i.ts": 'import "@switchboard/nested";\n',
    });
    const mods = loadRepo(root);
    expect(mods.find((x) => x.name === "pult")!.imports).toEqual([
      "@switchboard/dynamic",
      "@switchboard/export",
      "@switchboard/from",
      "@switchboard/js",
      "@switchboard/mjs",
      "@switchboard/mts",
      "@switchboard/side",
      "@switchboard/type/deep.ts",
      "@switchboard/web-view",
    ]);
    expect(mods.find((x) => x.name === "pult-s")!.imports).toEqual(["@switchboard/nested"]);
  });

  it("react-dom и глубокий путь React — тоже рантайм страницы", () => {
    const root = repo({ "web/packages/a/module.json": mod("a"), "web/packages/a/a.ts": 'import { createRoot } from "react-dom/client";\n', "web/packages/b/module.json": mod("b"), "web/packages/b/b.ts": 'const r = "react";\n' });
    const mods = loadRepo(root);
    expect(mods.find((x) => x.name === "a")!.imports).toEqual(["@switchboard/web-view"]);
    expect(mods.find((x) => x.name === "b")!.imports).toEqual([]);
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

  it("контракт собирается для браузера: check идёт на странице, файловая система ему не нужна", async () => {
    const out = await build({ entryPoints: [join(GATE, "contract.ts")], bundle: true, platform: "browser", format: "esm", write: false, logLevel: "silent" });
    expect(out.errors).toEqual([]);
    expect(out.outputFiles[0].text).toContain("function check");
  });
});

describe("устройство кода против манифеста", () => {
  const gate = mod("gate", { provides: { "gate.verify": 1, "gate.revoked": 1 } });

  it("Worker зовёт чужое имя через привязку: без uses — нарушение; имя, которого у модуля нет, и база — не контракт", () => {
    // источник: факт 5 нояб., workers/push зовёт gate.revoked при uses только gate.verify
    const code = "export const f = (env) => { env.GATE.verify(1); env.GATE.revoked([]); env.GATE.zzz(); env.DB.prepare(''); env.OWN.key(); };\n";
    const files = { "workers/gate/module.json": gate, "workers/own/module.json": mod("own", { provides: { "own.key": 1 } }), "workers/own/src/a.ts": code };
    const bad = gateOn(repo({ ...files, "workers/own/module.json": mod("own", { provides: { "own.key": 1 }, uses: { "gate.verify@gate": 1 } }) }));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("gate: 1 нарушений\nмодуль own: зовёт gate.revoked — нет в uses");
    const good = gateOn(repo({ ...files, "workers/own/module.json": mod("own", { provides: { "own.key": 1 }, uses: { "gate.verify@gate": 1, "gate.revoked@gate": 1 } }) }));
    expect(good.status, good.stderr).toBe(0);
  });

  it("вызов в тесте не считается: тест зовёт что угодно", () => {
    const r = gateOn(repo({ "workers/gate/module.json": gate, "workers/own/module.json": mod("own"), "workers/own/test/a.test.ts": "env.GATE.revoked([]);\n" }));
    expect(r.status, r.stderr).toBe(0);
  });

  it.each<[string, Files, string]>([
    ["код идёт в чужой контракт без uses", { "web/packages/a/src/x.ts": 'import type { T } from "../../b/contract.ts";\n' }, "модуль a: импорт b/contract.ts — b нет в uses"],
    ["код идёт в чужой контракт, имя объявлено, но внутрь", { "web/packages/c/src/x.ts": 'import { t } from "../../b/src/in.ts";\n' }, "модуль c: импорт b/src/in.ts — мимо контракта b"],
    ["тест идёт во внутренности чужого модуля", { "web/packages/a/test/x.test.ts": 'import { t } from "../../b/src/in.ts";\n' }, "модуль a: тест импортирует b/src/in.ts — мимо контракта b"],
    ["стенд идёт во внутренности чужого модуля", { "web/packages/a/stand/x.ts": 'import { t } from "../../b/src/in.ts";\n' }, "модуль a: тест импортирует b/src/in.ts — мимо контракта b"],
    ["тест идёт во внутренности чужого пакета", { "web/packages/a/test/x.test.ts": 'import { t } from "@switchboard/b/src/in.ts";\n' }, "модуль a: тест импортирует b/src/in.ts — мимо контракта b"],
  ])("относительный путь считается импортом модуля: %s", (_n, files, want) => {
    const r = gateOn(
      repo({
        "web/packages/a/module.json": mod("a"),
        "web/packages/a/package.json": { name: "@switchboard/a" },
        "web/packages/b/module.json": mod("b", { provides: { t: 1 } }),
        "web/packages/b/package.json": { name: "@switchboard/b" },
        "web/packages/b/contract.ts": "export {};\n",
        "web/packages/c/module.json": mod("c", { uses: { "t@b": 1 } }),
        ...files,
      }),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(want);
  });

  it("можно: свой файл, чужой контракт из uses; тесту — контракт, манифест и стенд чужого модуля без uses; у модуля без контракта правила для тестов нет", () => {
    const r = gateOn(
      repo({
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
    );
    expect(r.status, r.stderr).toBe(0);
  });
});
