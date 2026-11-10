import { describe, expect, it } from "vitest";
import type { LedgerEvent } from "@sb/protocol";
import { stand } from "../../test/stand.ts";

const FILES = [
  { name: "host.tgz", sha256: "a".repeat(64), size: 10 },
  { name: "keeper-linux-amd64", sha256: "b".repeat(64), size: 20 },
  { name: "keeper-windows-amd64.exe", sha256: "c".repeat(64), size: 30 },
];

describe("выпуски", () => {
  it("загрузка сборки: ссылки PUT на каждый файл в папке своего флота; каталог показывает сборку", async () => {
    const s = stand();
    const up = (await s.ask("builds.upload", { build: 412, commit: "abc", files: FILES })).result as { links: Record<string, string> };
    expect(Object.keys(up.links)).toEqual(FILES.map((f) => f.name));
    expect(up.links["host.tgz"]).toContain(`/sb2-files/builds/${s.fleet}/412/host.tgz?`);
    expect(up.links["host.tgz"]).toContain("X-Amz-Signature=");
    expect((await s.ask("builds.list")).result).toMatchObject({ stable: null, pins: {}, builds: [{ build: 412, commit: "abc", files: FILES.map((f) => f.name) }] });
    expect(await s.ask("builds.upload", { build: 413, files: FILES }, "kanya1")).toMatchObject({ ok: false, error: "forbidden" });
  });

  it("выкладка: сборки нет — not_found; есть — запись, кадр «план изменился» всем Keeper и событие журнала", async () => {
    const s = stand();
    expect(await s.ask("builds.deploy", { build: 412 })).toMatchObject({ ok: false, error: "not_found" });
    expect(s.seen.broadcasts).toHaveLength(0);
    await s.ask("builds.upload", { build: 412, files: FILES });
    const r = await s.ask("builds.deploy", { build: 412 });
    expect(r.ok).toBe(true);
    expect(s.seen.broadcasts).toMatchObject([{ role: "keeper", frame: { type: "plan.changed", trace: r.trace } }]);
    expect((await s.ask("builds.list")).result).toMatchObject({ stable: 412 });
    const events = ((await s.ask("ledger.read", { what: "builds." })).result as { events: LedgerEvent[] }).events;
    expect(events).toMatchObject([{ what: "builds.deploy", who: "pult~yuri@example.com", text: "сборка 412", trace: r.trace }]);
  });

  it("план машины: её закрепление важнее сборки флота; снятие закрепления возвращает сборку флота; ссылки GET по ОС", async () => {
    const s = stand();
    expect((await s.ask("builds.plan", { os: "linux" }, "klaptop")).result).toBeNull();
    await s.ask("builds.upload", { build: 412, files: FILES });
    await s.ask("builds.upload", { build: 409, files: FILES });
    await s.ask("builds.deploy", { build: 412 });
    await s.ask("builds.deploy", { build: 409, machine: "laptop" });
    const plan = (await s.ask("builds.plan", { os: "windows" }, "klaptop")).result as { build: number; host: { url: string; sha256: string }; keeper: { url: string; sha256: string } };
    expect(plan.build).toBe(409);
    expect(plan.host.sha256).toBe("a".repeat(64));
    expect(plan.keeper.sha256).toBe("c".repeat(64));
    expect(plan.keeper.url).toContain(`/builds/${s.fleet}/409/keeper-windows-amd64.exe?`);
    expect(((await s.ask("builds.plan", { os: "linux" }, "kolegm")).result as { build: number }).build).toBe(412);
    await s.ask("builds.deploy", { build: null, machine: "laptop" });
    expect(((await s.ask("builds.plan", { os: "linux" }, "klaptop")).result as { build: number }).build).toBe(412);
    // план спрашивает только машина
    expect(await s.ask("builds.plan", { os: "linux" }, "kyura1")).toMatchObject({ ok: false, error: "forbidden" });
    // файла под эту ОС в сборке нет — отказ словом
    expect(await s.ask("builds.plan", { os: "darwin", arch: "arm64" }, "klaptop")).toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("выпуски: человек ставит машину", () => {
  it("builds.keeper отдаёт файл Keeper стоящей сборки, ссылку и команду установки без приглашения в ней; сборка не назначена — not_found", async () => {
    const s = stand();
    expect(await s.ask("builds.keeper", { os: "linux" }, "kanya1")).toMatchObject({ ok: false, error: "not_found" });
    await s.ask("builds.upload", { build: 412, files: FILES });
    await s.ask("builds.deploy", { build: 412 });
    const r = (await s.ask("builds.keeper", { os: "linux" }, "kanya1")).result as { build: number; file: string; url: string; sha256: string; command: string };
    expect(r).toMatchObject({ build: 412, file: "keeper-linux-amd64", sha256: "b".repeat(64) });
    expect(r.url).toContain(`/builds/${s.fleet}/412/keeper-linux-amd64?`);
    expect(r.command).toContain("./keeper install --base ");
    const w = (await s.ask("builds.keeper", { os: "windows" }, "kanya1")).result as { command: string };
    expect(w.command).toContain("keeper.exe install --base ");
    expect(w.command).toContain("--logon");
  });
});

describe("выпуски: отпечаток кода", () => {
  it("отпечаток, названный при загрузке, виден в каталоге у своей сборки", async () => {
    const s = stand();
    await s.ask("builds.upload", { build: 412, digest: "d".repeat(64), files: FILES });
    await s.ask("builds.upload", { build: 413, files: FILES });
    const list = (await s.ask("builds.list")).result as { builds: { build: number; digest?: string }[] };
    expect(list.builds.map((b) => [b.build, b.digest])).toEqual([[413, undefined], [412, "d".repeat(64)]]);
    await s.ask("builds.deploy", { build: 413 });
    await s.ask("builds.deploy", { build: 412, machine: "laptop" });
    expect((await s.ask("builds.list")).result).toMatchObject({ stable: 413, pins: { laptop: 412 } });
  });
});

// устав: «система ловит» — отказ словом с причиной, ничего не изменено
describe("выпуски: отказы словом", () => {
  it("флоту без номера сборки — bad_input: сборка флота прежняя, Keeper никто не звал", async () => {
    const s = stand();
    await s.ask("builds.upload", { build: 412, files: FILES });
    await s.ask("builds.deploy", { build: 412 });
    s.seen.broadcasts.length = 0;
    expect(await s.ask("builds.deploy", { build: null })).toMatchObject({ ok: false, error: "bad_input" });
    expect((await s.ask("builds.list")).result).toMatchObject({ stable: 412 });
    expect(s.seen.broadcasts).toHaveLength(0);
  });

  it("в стоящей сборке нет Keeper под эту ОС — not_found с номером сборки и именем файла", async () => {
    const s = stand();
    await s.ask("builds.upload", { build: 412, files: FILES });
    await s.ask("builds.deploy", { build: 412 });
    const r = await s.ask("builds.keeper", { os: "darwin", arch: "arm64" }, "kanya1");
    expect(r).toMatchObject({ ok: false, error: "not_found" });
    expect(String(r.why)).toContain("412");
    expect(String(r.why)).toContain("keeper-darwin-arm64");
  });
});
