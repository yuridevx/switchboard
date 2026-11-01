// Эталоны machine на стенде Host: поддельные relay и держатели, папки — во временной папке. Номер эталона — номер теста.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Manifest } from "@switchboard/host";
import { machine } from "../src/machine.ts";

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "module.json"), "utf8")) as Manifest;
const stands: stand.Stand[] = [];
afterEach(async () => {
  for (const st of stands.splice(0)) await st.close();
});

/** Host машины pc с модулем machine; ~ — временная папка с ~/Projects. */
async function pc() {
  const home = mkdtempSync(join(tmpdir(), "switchboard-machine-"));
  mkdirSync(join(home, "Projects"));
  for (const d of ["wiki", "poe2", "switchboard", "site"]) mkdirSync(join(home, "Projects", d));
  writeFileSync(join(home, "Projects", "README.md"), "#");
  writeFileSync(join(home, "Projects", "todo.txt"), "-");
  const st = await stand.standHost({ machine: "pc", modules: [{ manifest, module: machine({ home }) }] });
  stands.push(st);
  return { st, home };
}
const refusals = (st: stand.Stand) => st.journal().filter((l) => l.kind === "refuse" && l.ev === "request");

describe("эталоны machine", () => {
  it("90 · machine.dirs ~/Projects на pc: только папки по имени, файлов нет; сессии и процессы не тронуты", async () => {
    const { st } = await pc();
    const r = await st.relay.request({ type: "machine.dirs", v: 1, machine: "pc", path: "~/Projects" });
    expect(r).toMatchObject({ type: "reply", ok: true, result: { path: "~/Projects", dirs: ["poe2", "site", "switchboard", "wiki"] } });
    expect(st.holders.ops).toEqual([]);
    expect(st.kernel.sessions.size).toBe(0);
  });

  it("91 · опечатка — not_found, путь не от ~ — bad_frame; две строки refuse с путём; ничего не подобрано и не создано", async () => {
    const { st, home } = await pc();
    expect(await st.relay.request({ type: "machine.dirs", v: 1, machine: "pc", path: "~/Projets" })).toMatchObject({ ok: false, error: "not_found" });
    expect(await st.relay.request({ type: "machine.dirs", v: 1, machine: "pc", path: "Projects" })).toMatchObject({ ok: false, error: "bad_frame" });
    expect(await st.relay.request({ type: "machine.dirs", v: 1, machine: "pc" })).toMatchObject({ ok: false, error: "bad_frame" });
    const lines = refusals(st);
    expect(lines.map((l) => l.word)).toEqual(["not_found", "bad_frame", "bad_frame"]);
    expect(lines[0].why).toContain("~/Projets");
    expect(lines[1].why).toContain("«Projects»");
    expect(lines[0].why).toContain("panel-desk~owner@example.com");
    expect(readdirSync(home)).toEqual(["Projects"]);
  });

  it("238 · machine.mkdir: создана, второй раз — exists, опечатка в родителе — not_found; сессий нет", async () => {
    const { st, home } = await pc();
    expect(await st.relay.request({ type: "machine.mkdir", v: 1, machine: "pc", path: "~/Projects/board" })).toMatchObject({ ok: true, result: { path: "~/Projects/board" } });
    expect(existsSync(join(home, "Projects", "board"))).toBe(true);
    expect(await st.relay.request({ type: "machine.mkdir", v: 1, machine: "pc", path: "~/Projects/board" })).toMatchObject({ ok: false, error: "exists" });
    expect(await st.relay.request({ type: "machine.mkdir", v: 1, machine: "pc", path: "~/Projets/board" })).toMatchObject({ ok: false, error: "not_found" });
    expect(existsSync(join(home, "Projets"))).toBe(false);
    expect(st.kernel.sessions.size).toBe(0);
  });
});

describe("machine", () => {
  it("полный путь и ~ без хвоста; папка на точку отдаётся — прятать решает клиент", async () => {
    const { st, home } = await pc();
    mkdirSync(join(home, ".claude"));
    expect(await st.relay.request({ type: "machine.dirs", v: 1, machine: "pc", path: "~" })).toMatchObject({ ok: true, result: { dirs: [".claude", "Projects"] } });
    const full = join(home, "Projects");
    expect(await st.relay.request({ type: "machine.dirs", v: 1, machine: "pc", path: full })).toMatchObject({ ok: true, result: { path: full } });
  });

  it("путь — файл: not_found", async () => {
    const { st } = await pc();
    expect(await st.relay.request({ type: "machine.dirs", v: 1, machine: "pc", path: "~/Projects/todo.txt" })).toMatchObject({ ok: false, error: "not_found" });
  });
});

/** Папка без доступа: chmod 000 на Linux. На Windows своей такой не сделать, а системные не трогаем; под root доступ есть всегда — null. */
function locked(home: string): string | null {
  if (process.platform === "win32" || process.getuid?.() === 0) return null;
  const p = join(home, "locked");
  mkdirSync(p);
  chmodSync(p, 0);
  return p;
}

describe("machine: покрытие плана host-modules", () => {
  it("3015 · нет доступа — no_access у dirs и mkdir; модуль жив", async (t) => {
    // источник: чьё: код (machine/contract.ts:4; machine.ts:42, :52)
    const { st, home } = await pc();
    const p = locked(home);
    if (!p) return t.skip();
    expect(await st.relay.request({ type: "machine.dirs", v: 1, machine: "pc", path: p })).toMatchObject({ ok: false, error: "no_access" });
    expect(await st.relay.request({ type: "machine.mkdir", v: 1, machine: "pc", path: join(p, "x") })).toMatchObject({ ok: false, error: "no_access" });
    expect(await st.relay.request({ type: "machine.dirs", v: 1, machine: "pc", path: "~" })).toMatchObject({ ok: true });
  });

  it("3016 · dirs: незнакомая ошибка ОС — ошибка модуля, machine выключен на машине", async () => {
    // источник: слово пользователя (устав: «ошибка модуля — модуль выключен»); host/core/contract.ts — вызов без сессии выключает модуль на машине
    const { st } = await pc();
    // путь с нулевым байтом: ОС его не примет, слова для кода ошибки у модуля нет
    const bad = "~/a\u0000b";
    expect(await st.relay.request({ type: "machine.dirs", v: 1, machine: "pc", path: bad })).toMatchObject({ ok: false, error: "module_error" });
    expect(await st.relay.request({ type: "machine.dirs", v: 1, machine: "pc", path: "~" })).toMatchObject({ ok: false, error: "module_error" });
    expect(st.journal().some((l) => l.ev === "module_failed" && l.module === "host-machine")).toBe(true);
  });

  it("3017 · mkdir: незнакомая ошибка ОС — ошибка модуля, machine выключен на машине", async () => {
    // источник: слово пользователя (устав: «ошибка модуля — модуль выключен»)
    const { st } = await pc();
    const bad = "~/a\u0000b";
    expect(await st.relay.request({ type: "machine.mkdir", v: 1, machine: "pc", path: bad })).toMatchObject({ ok: false, error: "module_error" });
    expect(await st.relay.request({ type: "machine.mkdir", v: 1, machine: "pc", path: "~/ok" })).toMatchObject({ ok: false, error: "module_error" });
  });
});
