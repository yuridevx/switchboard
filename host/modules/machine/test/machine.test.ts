// Эталоны machine на стенде Host: поддельные relay и keeper, папки — во временной папке. Номер эталона — номер теста.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
    expect(st.keeper.ops.map((o) => o.op)).toEqual(["control", "list", "ready"]);
    expect(st.kernel.sessions.size).toBe(0);
  });

  it("91 · опечатка — not_found, путь не от ~ — bad_frame; две строки refuse с путём; ничего не подобрано и не создано", async () => {
    const { st, home } = await pc();
    expect(await st.relay.request({ type: "machine.dirs", v: 1, machine: "pc", path: "~/Projets" })).toMatchObject({ ok: false, error: "not_found" });
    expect(await st.relay.request({ type: "machine.dirs", v: 1, machine: "pc", path: "Projects" })).toMatchObject({ ok: false, error: "bad_frame" });
    const lines = refusals(st);
    expect(lines.map((l) => l.word)).toEqual(["not_found", "bad_frame"]);
    expect(lines[0].why).toContain("~/Projets");
    expect(lines[1].why).toContain("«Projects»");
    expect(lines[0].why).toContain("panel-desk");
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
  it("machine.state: версии Host и SDK, Node, ОС, время старта; процессы — ответ keeper list как есть", async () => {
    const { st } = await pc();
    st.keeper.addProcess("poe-bot@pc");
    const r = await st.relay.request({ type: "machine.state", v: 1, machine: "pc" });
    expect(r).toMatchObject({ ok: true, result: { host: "1.4.0", sdk: "0.3.311", node: process.version, os: { platform: process.platform, arch: process.arch } } });
    const res = r.result as { started: string; processes: Array<Record<string, unknown>> };
    expect(Date.parse(res.started)).toBeLessThanOrEqual(Date.now());
    expect(res.processes).toEqual([{ id: "poe-bot@pc", pid: st.keeper.procs.get("poe-bot@pc")!.pid, attached: false, buffered: 0 }]);
  });

  it("полный путь и ~ без хвоста; папка на точку отдаётся — прятать решает клиент", async () => {
    const { st, home } = await pc();
    mkdirSync(join(home, ".claude"));
    expect(await st.relay.request({ type: "machine.dirs", v: 1, machine: "pc", path: "~" })).toMatchObject({ ok: true, result: { dirs: [".claude", "Projects"] } });
    const full = join(home, "Projects");
    expect(await st.relay.request({ type: "machine.dirs", v: 1, machine: "pc", path: full })).toMatchObject({ ok: true, result: { path: full } });
  });

  it("путь — файл: not_found; без пути — bad_frame", async () => {
    const { st } = await pc();
    expect(await st.relay.request({ type: "machine.dirs", v: 1, machine: "pc", path: "~/Projects/todo.txt" })).toMatchObject({ ok: false, error: "not_found" });
    expect(await st.relay.request({ type: "machine.dirs", v: 1, machine: "pc" })).toMatchObject({ ok: false, error: "bad_frame" });
  });
});
