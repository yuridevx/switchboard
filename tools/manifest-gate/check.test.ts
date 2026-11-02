import { describe, expect, it } from "vitest";
import { check, order, type Manifest } from "./contract.ts";

const m = (name: string, x: Partial<Manifest> = {}): Manifest => ({
  name, type: "worker", version: "1.0.0", provides: {}, uses: {}, config: {}, pkg: `@switchboard/${name}`, imports: [], ...x,
});

describe("гейт манифестов", () => {
  it("2074 · годный набор — без нарушений: protocol и свой пакет без uses — не нарушение", () => {
    const set = [
      m("gate", { provides: { "gate.verify": 1 }, config: { FLEET_SECRET: "secret" } }),
      m("relay", { provides: { hello: 1 }, uses: { "gate.verify@gate": 1 }, imports: ["@switchboard/gate", "@switchboard/protocol", "@switchboard/relay/src/link.ts"] }),
    ];
    expect(check(set)).toEqual([]);
  });

  it("140 · два владельца у имени — сборка остановлена", () => {
    expect(check([m("host-push", { provides: { notify: 1 } }), m("budget", { provides: { notify: 1 } })])).toEqual([
      "имя notify: два владельца — host-push и budget",
    ]);
  });

  it("141 · uses другой версии и без владельца", () => {
    const e = check([m("push", { provides: { "push.send": 1 } }), m("host-push", { uses: { "push.send@push": 2, "x@nobody": 1, bad: 1 } })]);
    expect(e).toEqual([
      "модуль host-push: uses push.send@push v2 — у владельца v1",
      "модуль host-push: uses x@nobody — владельца нет в наборе",
      "модуль host-push: uses «bad» — нужно имя@владелец",
    ]);
  });

  it("142 · импорт мимо uses", () => {
    const e = check([m("host-push", { provides: { notify: 1 } }), m("watch", { imports: ["@switchboard/host-push"] })]);
    expect(e).toEqual(["модуль watch: импорт @switchboard/host-push — host-push нет в uses"]);
  });

  it("142 · глубокий импорт мимо контракта при объявленном uses", () => {
    const e = check([m("host-push", { provides: { notify: 1 } }), m("watch", { uses: { "notify@host-push": 1 }, imports: ["@switchboard/host-push/src/send.ts"] })]);
    expect(e).toEqual(["модуль watch: импорт @switchboard/host-push/src/send.ts — мимо контракта @switchboard/host-push"]);
  });

  it("2075 · импорт модуля, которого нет в наборе, и uses на имя, которого владелец не отдаёт", () => {
    const e = check([m("push", { provides: { "push.send": 1 } }), m("watch", { uses: { "push.key@push": 1 }, imports: ["@switchboard/ghost"] })]);
    expect(e).toEqual(["модуль watch: uses push.key@push — push не отдаёт push.key", "модуль watch: импорт @switchboard/ghost — такого модуля нет"]);
  });

  it("2073 · npm run gate на монорепо: выход 0 и строка с числами", async () => {
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
    const r = spawnSync(process.execPath, [cli], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toMatch(/^gate: ok · \d+ модулей · \d+ имён контракта$/);
  });

  it("5111 · into называет корень сборки своего типа: модуль Host — в ядро, экран — в оболочку страницы; у Worker into нет", () => {
    const set = [
      m("host", { type: "sdk-core" }),
      m("pult", { type: "web-app" }),
      m("host-chat", { type: "sdk", into: ["host"] }),
      m("pult-open", { type: "web", into: ["pult"] }),
    ];
    expect(check(set)).toEqual([]);
    expect(
      check([...set, m("host-x", { type: "sdk", into: ["pult"] }), m("web-x", { type: "web", into: ["phone"] }), m("push", { into: ["host"] })]),
    ).toEqual(["модуль host-x: into pult — pult не sdk-core", "модуль web-x: into phone — такого приложения нет в наборе", "модуль push: into у типа worker не бывает"]);
  });

  it("5114 · список сборки — в порядке зависимостей: order ставит владельца раньше; check ловит цикл в любом порядке", () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): список сборки — зависимость раньше
    const watch = m("host-watch", { type: "sdk", provides: { "session.watchers": 1 } });
    const push = m("host-push", { type: "sdk", provides: { notify: 1 }, uses: { "session.watchers@host-watch": 1 } });
    const q = m("host-questions", { type: "sdk", uses: { "notify@host-push": 1, "session.watchers@host-watch": 1 } });
    expect(order([q, push, watch]).map((x) => x.name)).toEqual(["host-watch", "host-push", "host-questions"]);
    expect(check([q, watch, push])).toEqual([]);
    const a1 = m("a", { provides: { x: 1 }, uses: { "y@b": 1 } });
    const b1 = m("b", { provides: { y: 1 }, uses: { "z@c": 1 } });
    const c1 = m("c", { provides: { z: 1 }, uses: { "x@a": 1 } });
    expect(check([c1, b1, a1, watch])).toEqual(["цикл зависимостей: c → a → b → c"]);
  });

  it("секрет в двух модулях и повтор имени модуля", () => {
    const e = check([m("gate", { config: { FLEET_SECRET: "secret" } }), m("relay", { config: { FLEET_SECRET: "secret" } }), m("relay")]);
    expect(e).toContain("секрет FLEET_SECRET: в config двух модулей — gate и relay");
    expect(e).toContain("модуль relay: имя уже занято");
  });
});
