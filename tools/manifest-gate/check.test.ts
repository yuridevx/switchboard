import { describe, expect, it } from "vitest";
import { check, type Manifest } from "./contract.ts";

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

  it("секрет в двух модулях и повтор имени модуля", () => {
    const e = check([m("gate", { config: { FLEET_SECRET: "secret" } }), m("relay", { config: { FLEET_SECRET: "secret" } }), m("relay")]);
    expect(e).toContain("секрет FLEET_SECRET: в config двух модулей — gate и relay");
    expect(e).toContain("модуль relay: имя уже занято");
  });
});
