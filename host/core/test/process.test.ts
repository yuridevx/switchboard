// Эталоны процесса Host (738–743): main.ts отдельным процессом — гейт выпуска --check и отказы старта.
// Выпуск с другим списком модулей — копия ядра во временной папке: @switchboard/host — эта копия,
// прочие пакеты — ссылки на пакеты монорепо; поддельные модули — пакеты на JS.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROTO } from "@switchboard/relay";

const coreDir = join(import.meta.dirname, "..");
const rootModules = join(coreDir, "..", "..", "node_modules");

type Run = { code: number | null; out: string; err: string };

/** node main.ts: ввод открыт, пока процесс не выйдет сам. */
function run(main: string, args: string[], env: Record<string, string>): Promise<Run> {
  const e: Record<string, string | undefined> = { ...process.env, ...env };
  if (!("SWITCHBOARD_MACHINE" in env)) delete e.SWITCHBOARD_MACHINE;
  delete e.SWITCHBOARD_RELAY;
  return new Promise((res) => {
    const p = spawn(process.execPath, [main, ...args], { env: e, windowsHide: true });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => p.kill(), 60_000);
    p.on("close", (code) => {
      clearTimeout(t);
      res({ code, out, err });
    });
  });
}

/** Модуль-пакет на JS: манифест и пустой объект модуля. */
type Fake = { provides: Record<string, number> };

/** Выпуск: копия ядра со своим modules.json; возвращает путь к main.ts копии. */
function release(names: string[], fakes: Record<string, Fake> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-release-"));
  const copy = join(dir, "core");
  cpSync(join(coreDir, "src"), join(copy, "src"), { recursive: true });
  for (const f of ["main.ts", "contract.ts", "module.json", "package.json"]) cpSync(join(coreDir, f), join(copy, f));
  writeFileSync(join(copy, "modules.json"), JSON.stringify(names));
  const sw = join(dir, "node_modules", "@switchboard");
  mkdirSync(sw, { recursive: true });
  for (const n of readdirSync(join(rootModules, "@switchboard"))) {
    if (n !== "host") symlinkSync(realpathSync(join(rootModules, "@switchboard", n)), join(sw, n), "junction");
  }
  symlinkSync(copy, join(sw, "host"), "junction");
  symlinkSync(realpathSync(join(rootModules, "@anthropic-ai")), join(dir, "node_modules", "@anthropic-ai"), "junction");
  for (const [name, m] of Object.entries(fakes)) {
    const d = join(dir, "fakes", name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: `@switchboard/${name}`, type: "module", exports: { ".": "./contract.js" } }));
    writeFileSync(join(d, "module.json"), JSON.stringify({ name, type: "sdk", version: "1.0.0", provides: m.provides, uses: {}, config: {} }));
    writeFileSync(join(d, "contract.js"), "export default {};\n");
    symlinkSync(d, join(sw, name), "junction");
  }
  return join(copy, "main.ts");
}

const home = () => mkdtempSync(join(tmpdir(), "switchboard-home-"));
const dup = { "host-a": { provides: { "x.do": 1 } }, "host-b": { provides: { "x.do": 1 } } };

describe("процесс Host", () => {
  it("738 · --check годного выпуска: ok, версия, SDK 0.3.311 и proto; код 0", async () => {
    // источник: устав «версия SDK закреплена точно»; ответ одной строкой JSON — чьё: код
    const r = await run(join(coreDir, "main.ts"), ["--check"], {});
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.trim())).toEqual({ ok: true, version: "1.0.0", sdk: "0.3.311", proto: PROTO });
  }, 90_000);

  it("739 · --check: у имени два владельца — ok:false с причиной, код 1", async () => {
    // источник: устав «двое — Host не стартует»
    const r = await run(release(["host-a", "host-b"], dup), ["--check"], {});
    expect(r.code).toBe(1);
    const x = JSON.parse(r.out.trim());
    expect(x.ok).toBe(false);
    expect(x.why).toContain("x.do: два владельца — host-a и host-b");
  }, 90_000);

  it("740 · --check: пакета модуля нет — ok:false со словами ошибки, код 1", async () => {
    // источник: устав «система ловит… отказывает, пишет причину»
    const r = await run(release(["host-nope"]), ["--check"], {});
    expect(r.code).toBe(1);
    const x = JSON.parse(r.out.trim());
    expect(x.ok).toBe(false);
    expect(x.why).toContain("@switchboard/host-nope");
  }, 90_000);

  it("741 · Host без SWITCHBOARD_MACHINE — отказ словами в stderr, код 1", async () => {
    // источник: устав «Host… часть машины, её запускает keeper»; слова — чьё: код
    const r = await run(join(coreDir, "main.ts"), [], { SWITCHBOARD_HOME: home() });
    expect(r.code).toBe(1);
    expect(r.err).toContain("host: нет SWITCHBOARD_MACHINE — Host запускает keeper");
  }, 90_000);

  it("742 · Host: у имени два владельца — «host: не стартует» с причиной, код 1", async () => {
    // источник: устав «двое — Host не стартует»
    const r = await run(release(["host-a", "host-b"], dup), [], { SWITCHBOARD_MACHINE: "laptop", SWITCHBOARD_HOME: home() });
    expect(r.code).toBe(1);
    expect(r.err).toContain("host: не стартует");
    expect(r.err).toContain("x.do: два владельца — host-a и host-b");
  }, 90_000);

  it("743 · Host: пакета модуля нет — «host:» с причиной, код 1", async () => {
    // источник: устав «Код системы только обнаруживает ошибку и не пускает её дальше»; дальше ведёт keeper
    const r = await run(release(["host-nope"]), [], { SWITCHBOARD_MACHINE: "laptop", SWITCHBOARD_HOME: home() });
    expect(r.code).toBe(1);
    expect(r.err).toContain("host:");
    expect(r.err).toContain("@switchboard/host-nope");
  }, 90_000);
});
