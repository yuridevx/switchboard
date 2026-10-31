// Совместимость с настоящим keeper (os/keeper, Go): клиент ядра и main.ts против его протокола.
// Пропускается без SWITCHBOARD_KEEPER_BIN — пути к собранному keeper.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { KeeperClient, parseKeeperLine } from "../src/keeper.ts";
import type { Exited } from "../src/keeper.ts";
import { until } from "../stand/index.ts";

const BIN = process.env.SWITCHBOARD_KEEPER_BIN;
let keeper: ChildProcess | null = null;
afterEach(() => {
  keeper?.kill();
  keeper = null;
});

/** Папка ~/.switchboard с keeper.json и выпуском host/t/host. */
function home(hostScript: (h: string) => string): string {
  const h = mkdtempSync(join(tmpdir(), "switchboard-keeper-"));
  mkdirSync(join(h, "host", "t"), { recursive: true });
  writeFileSync(join(h, "keeper.json"), JSON.stringify({ node: process.execPath, host: "t" }));
  writeFileSync(join(h, "host", "t", "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(h, "host", "t", "host"), hostScript(h));
  return h;
}

function journal(h: string): Array<Record<string, unknown>> {
  const dir = join(h, "journal");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}

describe.skipIf(!BIN)("настоящий keeper", () => {
  it("клиент ядра: control, list, spawn с байтами в обе стороны, stdin.end → kill → exited, ready", async () => {
    // Host-заглушка: отдаёт строку ввода в файл и живёт, не открывая управления
    const h = home((dir) => `import { writeFileSync } from "node:fs";
let b = ""; process.stdin.on("data", (d) => { b += d; if (b.includes(String.fromCharCode(10))) writeFileSync(${JSON.stringify(join(dir, "line.txt"))}, b); });
setInterval(() => {}, 1000);`);
    keeper = spawn(BIN!, ["run"], { env: { ...process.env, SWITCHBOARD_HOME: h }, stdio: "ignore" });
    await until(() => existsSync(join(h, "line.txt")), 10_000);
    const addr = parseKeeperLine(readFileSync(join(h, "line.txt"), "utf8").trim());
    const exited: Exited[] = [];
    const c = new KeeperClient(addr, { exited: (e) => void exited.push(e), stop: () => {} });
    await c.connect();
    expect(await c.list()).toEqual([]);
    const p = c.channel("spawn", "echo@test", {
      command: process.execPath,
      args: ["-e", "process.stdin.pipe(process.stdout)"],
      cwd: h,
      env: process.env,
      signal: new AbortController().signal,
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stdin.write("пинг\n");
    await until(() => out.includes("пинг"), 10_000);
    expect((await c.list()).map((x) => x.id)).toEqual(["echo@test"]);
    const code = new Promise<number | null>((r) => p.on("exit", (c2) => r(c2)));
    p.stdin.end();
    expect(await code).toBe(0);
    expect(exited[0]).toMatchObject({ id: "echo@test", code: 0 });
    expect(await c.send({ op: "ready", version: "t" })).toMatchObject({ ok: true });
    expect(await c.send({ op: "ready", version: "9.9.9" })).toMatchObject({ ok: false, error: "unknown_version" });
    c.close();
  }, 30_000);

  it("main.ts под keeper: строка ввода, гейт, управление, ready", async () => {
    const main = pathToFileURL(join(import.meta.dirname, "..", "main.ts")).href;
    const h = home(() => `import ${JSON.stringify(main)};\n`);
    writeFileSync(join(h, "host.json"), JSON.stringify({ machine: "test" }));
    keeper = spawn(BIN!, ["run"], { env: { ...process.env, SWITCHBOARD_HOME: h }, stdio: "ignore" });
    await until(() => journal(h).some((l) => l.ev === "host_ready" || l.ev === "ready"), 20_000);
    const host = journal(h).filter((l) => l.part === "host").map((l) => l.ev);
    expect(host).toContain("host_start");
    expect(host).toContain("ready");
  }, 30_000);
});
