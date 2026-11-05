// Леса границы «пропуск участника», среда Node: инструменты seed и redeem настоящими процессами.
// Вход — аргументы и stdin, исход — вывод, поток ошибок, код выхода, кадр к gate. Номер — эталон-источник; без номера — чьё: код.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEED = join(ROOT, "seed.ts");
const REDEEM = join(ROOT, "redeem.ts");
const seed = (args: string[]) => spawnSync(process.execPath, [SEED, ...args], { encoding: "utf8" });
const USAGE_SEED = "использование: switchboard seed <host|client> <имя> [<почта человека у client>]\n";
const USAGE_REDEEM = "использование: <приглашение в stdin> | switchboard redeem <адрес gate>\n";

const used = new Set<string>();
const frames: Array<Record<string, unknown>> = [];
let url = "";
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const f = JSON.parse(body);
    frames.push(f);
    const ok = f.type === "gate.redeem" && !used.has(f.invite);
    used.add(f.invite);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(ok ? { type: "reply", id: f.id, ok: true, result: { key: `client.ci.${f.invite.split(".")[0]}.SECRET` } } : { type: "reply", id: f.id, ok: false, error: "bad_invite" }));
  });
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(() => server.close());

function redeem(args: string[], input: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const p = spawn(process.execPath, [REDEEM, ...args]);
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.stderr.on("data", (c) => (stderr += c));
    p.on("close", (status) => res({ status, stdout, stderr }));
    p.stdin.end(input);
  });
}

describe("seed", () => {
  it("5013 · seed host laptop → инструкция вставки «ждёт приёма» с хэшем в выводе, приглашение — в поток ошибок; секрета в выводе нет", () => {
    const r = seed(["host", "laptop"]);
    expect(r.status).toBe(0);
    const inv = r.stderr.trim();
    expect(inv).toMatch(/^[a-z0-9]{4}\.[A-Za-z0-9_-]{43}$/);
    const [kid, code] = inv.split(".");
    const hash = createHash("sha256").update(code).digest("hex");
    expect(r.stdout).toMatch(new RegExp(`^INSERT INTO passes \\(id, role, name, person, state, hash, by, at\\) VALUES \\('${kid}', 'host', 'laptop', NULL, 'wait', '${hash}', 'seed', \\d+\\);\\n$`));
    expect(r.stdout).not.toContain(code);
  });

  it("seed client с почтой → почта в инструкции", () => {
    const r = seed(["client", "phone", "x@y"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("'client', 'phone', 'x@y', 'wait'");
  });

  it.each([
    ["без аргументов", []],
    ["без имени", ["host"]],
    ["роль не та", ["admin", "x"]],
    ["имя с недопустимым знаком", ["host", "lap.top"]],
    ["client без почты", ["client", "phone"]],
    ["у машины почта", ["host", "laptop", "x@y"]],
    ["почта без @", ["client", "phone", "owner"]],
    ["почта с кавычкой", ["client", "phone", "o'x@y"]],
  ])("%s → выход 2, использование; инструкции нет", (_n, args) => {
    const r = seed(args);
    expect(r.status).toBe(2);
    expect(r.stderr).toBe(USAGE_SEED);
    expect(r.stdout).toBe("");
  });
});

describe("redeem", () => {
  it("5057 · switchboard redeem → кадр gate.redeem, печатает пропуск, выход 0; погашенное приглашение → выход 1 со словом", async () => {
    const a = await redeem([url], "c1a2.INVITE\n");
    expect(a).toEqual({ status: 0, stdout: "client.ci.c1a2.SECRET\n", stderr: "" });
    expect(frames.at(-1)).toEqual({ type: "gate.redeem", id: "redeem", v: 1, invite: "c1a2.INVITE" });
    const b = await redeem([url], "c1a2.INVITE");
    expect(b.status).toBe(1);
    expect(b.stdout).toBe("");
    expect(b.stderr).toBe("redeem: bad_invite\n");
  });

  it.each([
    ["без адреса", []],
    ["адрес не http", ["ftp://gate"]],
  ])("%s → выход 2, использование", async (_n, args) => {
    const r = await redeem(args, "x");
    expect(r).toEqual({ status: 2, stdout: "", stderr: USAGE_REDEEM });
  });

  it("gate не ответил → выход 1 с причиной", async () => {
    const r = await redeem(["http://127.0.0.1:1/"], "x");
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^redeem: gate не ответил — /);
  });

  it("имена инструментов в манифесте пакета — на этих файлах: без аргументов каждый отвечает использованием", async () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { bin: Record<string, string> };
    expect(pkg.bin).toEqual({ "switchboard-seed": "./seed.ts", "switchboard-redeem": "./redeem.ts" });
    expect(spawnSync(process.execPath, [join(ROOT, pkg.bin["switchboard-seed"])], { encoding: "utf8" }).stderr).toBe(USAGE_SEED);
    expect(spawnSync(process.execPath, [join(ROOT, pkg.bin["switchboard-redeem"])], { encoding: "utf8", input: "x" }).stderr).toBe(USAGE_REDEEM);
  });
});
