import { describe, expect, it } from "vitest";
import type { LedgerEvent, ObsRow } from "@sb/protocol";
import { note } from "./obs/obs.ts";
import { stand } from "../../test/stand.ts";

const values = async (s: ReturnType<typeof stand>, scope: string, as = "kyura1", prefix?: string) => ((await s.ask("prefs.get", { scope, ...(prefix ? { prefix } : {}) }, as)).result as { values: Record<string, unknown> }).values;

describe("настройки", () => {
  it("значение целиком, заплатка одним запросом, null убирает ключ", async () => {
    const s = stand();
    await s.ask("prefs.set", { scope: "fleet", name: "projects", value: { site: { order: ["a"] }, docs: { order: [] } } });
    await s.ask("prefs.set", { scope: "fleet", name: "projects", patch: { site: { order: ["a", "b"] }, docs: null, infra: {} } });
    expect(await values(s, "fleet")).toEqual({ projects: { site: { order: ["a", "b"] }, infra: {} } });
    // заплатка по ключу, которого ещё нет, заводит его
    await s.ask("prefs.set", { scope: "fleet", name: "names", patch: { "site@laptop": "Сайт" } });
    expect((await values(s, "fleet", "kyura1", "na")).names).toEqual({ "site@laptop": "Сайт" });
    await s.ask("prefs.set", { scope: "fleet", name: "names", value: null });
    expect(await values(s, "fleet", "kyura1", "na")).toEqual({});
  });

  it("свои настройки у каждого человека свои; общие видят все", async () => {
    const s = stand();
    await s.ask("prefs.set", { scope: "me", name: "view", value: "плотный" }, "kanya1");
    await s.ask("prefs.set", { scope: "fleet", name: "names", value: { a: 1 } }, "kanya1");
    expect(await values(s, "me", "kanya1")).toEqual({ view: "плотный" });
    expect(await values(s, "me", "koleg1")).toEqual({});
    expect(await values(s, "fleet", "koleg1")).toEqual({ names: { a: 1 } });
  });

  it("запись в общие — кадр «изменилось» всем Host; в свои — нет", async () => {
    const s = stand();
    await s.ask("prefs.set", { scope: "me", name: "view", value: 1 });
    expect(s.seen.broadcasts).toHaveLength(0);
    await s.ask("prefs.set", { scope: "fleet", name: "names", value: {} });
    expect(s.seen.broadcasts).toMatchObject([{ role: "host", frame: { type: "changed", what: "names" } }]);
  });

  it("правила прокси меняет только админ; нужно ровно одно из value и patch", async () => {
    const s = stand();
    expect(await s.ask("prefs.set", { scope: "fleet", name: "proxy.rules", value: [] }, "kanya1")).toMatchObject({ ok: false, error: "forbidden" });
    expect(await s.ask("prefs.set", { scope: "fleet", name: "proxy.rules", value: [] })).toMatchObject({ ok: true });
    expect(await s.ask("prefs.set", { scope: "me", name: "x" })).toMatchObject({ ok: false, error: "bad_input" });
  });
});

describe("ключи флота", () => {
  // находка: правка одного свойства записанного ключа не затирает неназванные адрес и модель
  it("keys.set без адреса или модели оставляет их прежними", async () => {
    const s = stand();
    const keys = async () => ((await s.ask("keys.list", {}, "kanya1")).result as { keys: Record<string, unknown>[] }).keys;
    await s.ask("keys.set", { name: "orca", provider: "anthropic", value: "sk-secret-9876", base: "https://orca.example" });
    await s.ask("keys.set", { name: "orca", provider: "anthropic", model: "m1" });
    expect(await keys()).toMatchObject([{ name: "orca", base: "https://orca.example", model: "m1", tail: "9876" }]);
    await s.ask("keys.set", { name: "orca", provider: "anthropic", base: "https://orca2.example" });
    expect(await keys()).toMatchObject([{ name: "orca", base: "https://orca2.example", model: "m1" }]);
  });

  it("список без значений — только хвост; значение отдаётся машине; смена — кадр «изменилось»", async () => {
    const s = stand();
    await s.ask("keys.set", { name: "orca", provider: "anthropic", value: "sk-secret-9876", base: "https://orca.example" });
    const list = (await s.ask("keys.list", {}, "kanya1")).result as { keys: Record<string, unknown>[] };
    expect(list.keys).toMatchObject([{ name: "orca", provider: "anthropic", tail: "9876", base: "https://orca.example" }]);
    expect(JSON.stringify(list)).not.toContain("sk-secret");
    expect(await s.ask("keys.value", { name: "orca" }, "klaptop")).toMatchObject({ result: { value: "sk-secret-9876", provider: "anthropic" } });
    expect(await s.ask("keys.value", { name: "нет" }, "klaptop")).toMatchObject({ ok: false, error: "not_found" });
    expect(await s.ask("keys.remove", { name: "orca" }, "kanya1")).toMatchObject({ ok: false, error: "forbidden" });
    expect(await s.ask("keys.value", { name: "orca" }, "klaptop")).toMatchObject({ ok: true });
    await s.ask("keys.remove", { name: "orca" });
    expect(await s.ask("keys.value", { name: "orca" }, "klaptop")).toMatchObject({ ok: false, error: "not_found" });
    expect(s.seen.broadcasts.map((b) => [b.role, b.frame.type, b.frame.what])).toEqual([["host", "changed", "keys"], ["host", "changed", "keys"]]);
    expect(await s.ask("keys.set", { name: "x", provider: "p", value: "v" }, "kanya1")).toMatchObject({ ok: false, error: "forbidden" });
  });
});

describe("журнал флота", () => {
  it("события с автором и trace; фильтр по началу имени и машине; чужую машину видит только админ", async () => {
    const s = stand();
    const a = await s.ask("ledger.add", { what: "host.updated", machine: "laptop", text: "сборка 412", data: { build: 412 } }, "klaptop");
    await s.ask("ledger.add", { what: "host.failed", machine: "oleg-mac" }, "kolegm");
    await s.ask("ledger.add", { what: "login.done" }, "kanya1");
    const read = async (f: Record<string, unknown>, as = "kyura1") => ((await s.ask("ledger.read", f, as)).result as { events: LedgerEvent[] }).events;
    expect((await read({})).map((e) => e.what).sort()).toEqual(["host.failed", "host.updated", "login.done"]);
    expect(await read({ what: "host.", machine: "laptop" })).toMatchObject([{ what: "host.updated", who: "@laptop", machine: "laptop", text: "сборка 412", data: { build: 412 }, trace: a.trace }]);
    expect((await read({}, "kanya1")).map((e) => e.what).sort()).toEqual(["host.updated", "login.done"]);
  });
});

describe("наблюдение", () => {
  it("сводка: число, отказы, медиана и 95-й процентиль по именам; строки старше недели убираются", async () => {
    const s = stand();
    const now = Date.now();
    const row = (ms: number, ok: boolean, at = now, type = "message"): ObsRow => ({ trace: "t" + ms, at, type, from: "pult~yuri@example.com", to: "site@laptop", ok, ms, ...(ok ? {} : { word: "offline" }) });
    await note(s.env, s.fleet, row(1, true, now - 8 * 24 * 3600 * 1000));
    for (let i = 1; i <= 20; i++) await note(s.env, s.fleet, row(i * 10, i !== 20, now - i));
    const stats = (await s.ask("obs.stats", { since: now - 60_000, until: now + 1 })).result as { types: Record<string, unknown>[]; buckets: { n: number; failed: number }[] };
    expect(stats.types).toEqual([{ type: "message", n: 20, failed: 1, p50: 110, p95: 200 }]);
    expect(stats.buckets.reduce((n, b) => n + b.n, 0)).toBe(20);
    const failed = (await s.ask("obs.recent", { failed: true })).result as { rows: ObsRow[] };
    expect(failed.rows).toMatchObject([{ ms: 200, word: "offline", ok: false }]);
    expect(((await s.ask("obs.recent", { of: "t1" })).result as { rows: ObsRow[] }).rows).toHaveLength(0);
    expect(((await s.ask("obs.recent", { of: "t50" })).result as { rows: ObsRow[] }).rows).toMatchObject([{ ms: 50 }]);
  });

  it("строку о чужой машине видит только тот, кто до неё достаёт; ошибка страницы принимается", async () => {
    const s = stand();
    await s.ask("shell.info", { to: "@oleg-mac" }, "koleg1");
    expect(((await s.ask("obs.recent", {}, "kanya1")).result as { rows: ObsRow[] }).rows).toHaveLength(0);
    expect(((await s.ask("obs.recent", {}, "koleg1")).result as { rows: ObsRow[] }).rows).toMatchObject([{ type: "shell.info", to: "@oleg-mac" }]);
    expect(await s.ask("obs.report", { part: "web", level: "error", msg: "экран упал", stack: "at Chat" }, "kanya1")).toMatchObject({ ok: true });
  });

  // находка: ошибки, пойманные на месте, видит админ и тот, чьё это устройство или машина
  it("ошибку страницы в сводке здоровья видит её человек и админ; чужой не админ — нет", async () => {
    const s = stand();
    await s.ask("obs.report", { part: "web", level: "error", msg: "экран Ани упал" }, "kanya1");
    const reports = async (key: string) => ((await s.ask("obs.health", {}, key)).result as { reports: Array<{ msg: string }> }).reports.map((r) => r.msg);
    expect(await reports("kanya1")).toEqual(["экран Ани упал"]);
    expect(await reports("kyura1")).toEqual(["экран Ани упал"]);
    expect(await reports("koleg1")).toEqual([]);
  });
});
