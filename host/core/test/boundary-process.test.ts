// Леса ядра, сторона процесса (738–743, 752): main.ts отдельным процессом — гейт выпуска --check, отказы старта и ловушка процесса.
// Выпуск — сборка во временной папке, как у «Выпусков»: packages/host — копия ядра, @switchboard/host — ссылка на неё,
// прочие пакеты — ссылки на пакеты монорепо; поддельные модули — modules/<имя>/ на JS; build.json — список.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { createServer as createPlain } from "node:net";
import type { Socket } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROTO } from "@switchboard/relay";

/** номер ядра — из его манифеста: тесты не держат его числом */
const CORE_VERSION = (JSON.parse((process.getBuiltinModule("node:fs") as typeof import("node:fs")).readFileSync(new URL("../module.json", import.meta.url), "utf8")) as { version: string }).version;

const coreDir = join(import.meta.dirname, "..");
const rootModules = join(coreDir, "..", "..", "node_modules");

const sockets: Socket[] = [];
const createNet = (on: (c: Socket) => void) => createPlain((c) => { sockets.push(c); on(c); });

/** Минимальный WebSocket: принимает кадр hello и запоминает ключ. Кадры клиента в маске, длина до 64 КиБ. */
function createHttpWs(hellos: string[]) {
  const server = createServer();
  server.on("upgrade", async (req, socket) => {
    const { createHash } = await import("node:crypto");
    const accept = createHash("sha1").update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
    socket.on("error", () => {});
    socket.on("data", (d: Buffer) => {
      let len = d[1] & 0x7f;
      let at = 2;
      if (len === 126) { len = d.readUInt16BE(2); at = 4; }
      const mask = d.subarray(at, at + 4);
      const body = Buffer.from(d.subarray(at + 4, at + 4 + len).map((b, i) => b ^ mask[i % 4]));
      try {
        const f = JSON.parse(body.toString("utf8")) as { type?: string; key?: string };
        if (f.type === "hello") hellos.push(String(f.key));
      } catch { /* ping */ }
    });
  });
  return server;
}

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

/** Модуль-пакет на JS: манифест и объект модуля (по умолчанию пустой). */
type Fake = { provides: Record<string, number>; code?: string };

/** Сборка: копия ядра и модули по списку build.json; возвращает путь к main.ts копии. */
function release(names: string[], fakes: Record<string, Fake> = {}, workers: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-release-"));
  const copy = join(dir, "packages", "host");
  cpSync(join(coreDir, "src"), join(copy, "src"), { recursive: true });
  for (const f of ["main.ts", "contract.ts", "module.json", "package.json"]) cpSync(join(coreDir, f), join(copy, f));
  writeFileSync(join(dir, "build.json"), JSON.stringify({ app: "host", version: "1.2.0+1", fleet: "test", modules: names.map((name) => ({ name, version: "1.0.0" })), workers }));
  const sw = join(dir, "node_modules", "@switchboard");
  mkdirSync(sw, { recursive: true });
  for (const n of readdirSync(join(rootModules, "@switchboard"))) {
    if (n !== "host") symlinkSync(realpathSync(join(rootModules, "@switchboard", n)), join(sw, n), "junction");
  }
  symlinkSync(copy, join(sw, "host"), "junction");
  symlinkSync(realpathSync(join(rootModules, "@anthropic-ai")), join(dir, "node_modules", "@anthropic-ai"), "junction");
  for (const [name, m] of Object.entries(fakes)) {
    const d = join(dir, "modules", name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: `@switchboard/${name}`, type: "module", exports: { ".": "./contract.js" } }));
    writeFileSync(join(d, "module.json"), JSON.stringify({ name, type: "sdk", version: "1.0.0", into: ["host"], provides: m.provides, uses: {}, config: {} }));
    writeFileSync(join(d, "contract.js"), m.code ?? "export default {};\n");
  }
  return join(copy, "main.ts");
}

const home = () => mkdtempSync(join(tmpdir(), "switchboard-home-"));
const dup = { "host-a": { provides: { "x.do": 1 } }, "host-b": { provides: { "x.do": 1 } } };

/** Строки журнала Host в папке h, пока ok() не вернёт true или не выйдет срок. */
async function journalUntil(h: string, ok: (lines: Array<Record<string, unknown>>) => boolean, ms: number): Promise<Array<Record<string, unknown>>> {
  const dir = join(h, "journal");
  const read = () =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.startsWith("host-"))
          .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>))
      : [];
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 200))) {
    const lines = read();
    if (ok(lines)) return lines;
  }
  return read();
}

describe("процесс Host", () => {
  it("5173 · адреса relay и Worker'ов Host берёт из build.json сборки, не из окружения keeper", async () => {
    // источник: отчёт слепого архитектора 2 нояб., пункт 1 (дубликат состояния: адреса флота — в сборке, как у страниц);
    // дизайн «Открытый флот»: «список сборки: модули по зависимостям, Worker'ы и их адреса»
    const upgrades: string[] = [];
    const server = createServer();
    server.on("upgrade", (req, socket) => {
      upgrades.push(String(req.url));
      socket.destroy();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const main = release([], {}, { relay: `http://127.0.0.1:${port}/`, gate: "http://127.0.0.1:9/" });
    const h = home();
    const p = spawn(process.execPath, [main], { env: { ...process.env, SWITCHBOARD_MACHINE: "laptop", SWITCHBOARD_HOME: h, SWITCHBOARD_WORKERS: JSON.stringify({ relay: "https://чужой/" }) }, windowsHide: true });
    const closed = new Promise<number | null>((r) => p.on("close", (c) => r(c)));
    try {
      for (const t0 = Date.now(); !upgrades.length && Date.now() - t0 < 30_000; ) await new Promise((r) => setTimeout(r, 100));
      expect(upgrades[0]).toBe("/m/laptop");
    } finally {
      p.stdin.end();
      await closed;
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 90_000);

  it("715 · держатель не поднялся (нет SWITCHBOARD_HOLDER): сессия из хранилища — два выхода со словами держателя, failed; Host жив", async () => {
    // источник: устав «процесс claude умер — один resume, второй сбой до готовности — failed»
    const h = home();
    mkdirSync(join(h, "store"), { recursive: true });
    writeFileSync(join(h, "store", "core.json"), JSON.stringify({ sessions: [{ callsign: "site@laptop", session_id: "44444444-4444-4444-8444-444444444444", cwd: h, sdk: "0.3.311", stopped: false }] }));
    const e: Record<string, string | undefined> = { ...process.env, SWITCHBOARD_MACHINE: "laptop", SWITCHBOARD_HOME: h };
    delete e.SWITCHBOARD_HOLDER;
    const p = spawn(process.execPath, [join(coreDir, "main.ts")], { env: e, windowsHide: true });
    const closed = new Promise<number | null>((r) => p.on("close", (c) => r(c)));
    const lines = await journalUntil(h, (ls) => ls.some((l) => l.ev === "ready"), 60_000);
    const exited = lines.filter((l) => l.ev === "session_exited");
    expect(exited).toHaveLength(2);
    expect(String(exited[0].why)).toContain("держатель: нет SWITCHBOARD_HOLDER — файла держателя");
    expect(lines.filter((l) => l.ev === "session_failed")).toHaveLength(1);
    p.stdin.end();
    expect(await closed).toBe(0);
  }, 90_000);

  it("настоящие держатели: аргументы hold, папка данных в окружении, строка с портом; слово отказа держателя — выход со словами", async () => {
    // источник: шапка протокола держателя (заморожен); keeper читает эти аргументы
    const h = home();
    mkdirSync(join(h, "store"), { recursive: true });
    const sid = "44444444-4444-4444-8444-444444444444";
    writeFileSync(join(h, "store", "core.json"), JSON.stringify({ sessions: [{ callsign: "site@laptop", session_id: sid, cwd: h, sdk: "0.3.311", stopped: false }] }));
    // файл держателя — скрипт: запоминает аргументы и окружение, поднимает порт, на подключение отвечает словом отказа
    writeFileSync(join(h, "hold"), [
      'const fs = require("fs"), net = require("net");',
      'fs.appendFileSync("hold-args.jsonl", JSON.stringify({ args: process.argv.slice(1), home: process.env.SWITCHBOARD_HOME }) + "\\n");',
      'const s = net.createServer((c) => { c.on("error", () => {}); const b = Buffer.from("нет"); const f = Buffer.alloc(5); f.write("e"); f.writeUInt32BE(b.length, 1); c.end(Buffer.concat([f, b])); });',
      's.listen(0, "127.0.0.1", () => { console.log(JSON.stringify({ port: s.address().port, key: "k", pid: process.pid })); setTimeout(() => process.exit(0), 3000); });',
    ].join("\n"));
    const p = spawn(process.execPath, [join(coreDir, "main.ts")], { cwd: h, env: { ...process.env, SWITCHBOARD_MACHINE: "laptop", SWITCHBOARD_HOME: h, SWITCHBOARD_HOLDER: process.execPath }, windowsHide: true });
    const closed = new Promise<number | null>((r) => p.on("close", (c) => r(c)));
    const lines = await journalUntil(h, (ls) => ls.some((l) => l.ev === "ready"), 60_000);
    p.stdin.end();
    expect(await closed).toBe(0);
    const exited = lines.filter((l) => l.ev === "session_exited");
    expect(exited).toHaveLength(2);
    expect(String(exited[0].why)).toContain("держатель: нет");
    const first = JSON.parse(readFileSync(join(h, "hold-args.jsonl"), "utf8").split("\n")[0]) as { args: string[]; home: string };
    expect(first.home).toBe(h);
    expect(first.args[0].endsWith("hold")).toBe(true);
    expect(first.args.slice(1, 7)).toEqual(["--id", "site@laptop", "--owner", "host", "--cwd", h]);
    expect(first.args[7]).toBe("--");
  }, 90_000);

  it("файл держателя молчит или вышел: причина со словами; файлы procs — только свои, битый не мешает, ничей убит кадром k", async () => {
    // источник: устав «пишет в журнал с причиной»; шапка протокола держателя
    const got: Buffer[] = [];
    const server = createNet((c) => {
      c.on("error", () => {});
      c.on("data", (d) => got.push(d));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const h = home();
    mkdirSync(join(h, "store"), { recursive: true });
    mkdirSync(join(h, "procs"), { recursive: true });
    writeFileSync(join(h, "procs", "old.json"), JSON.stringify({ id: "old@laptop", owner: "host", pid: 77, port, key: "key" }));
    writeFileSync(join(h, "procs", "chrome.json"), JSON.stringify({ id: "chrome", owner: "keeper", pid: 78, port, key: "key" }));
    writeFileSync(join(h, "procs", "broken.json"), "{");
    writeFileSync(join(h, "procs", "note.txt"), "x");
    writeFileSync(join(h, "store", "core.json"), JSON.stringify({ sessions: [{ callsign: "site@laptop", session_id: "44444444-4444-4444-8444-444444444444", cwd: h, sdk: "0.3.311", stopped: false }] }));
    // файл держателя выходит с кодом и словами: node без скрипта hold
    const p = spawn(process.execPath, [join(coreDir, "main.ts")], { cwd: h, env: { ...process.env, SWITCHBOARD_MACHINE: "laptop", SWITCHBOARD_HOME: h, SWITCHBOARD_HOLDER: process.execPath }, windowsHide: true });
    const closed = new Promise<number | null>((r) => p.on("close", (c) => r(c)));
    const lines = await journalUntil(h, (ls) => ls.some((l) => l.ev === "orphan_kill") && Buffer.concat(got).toString("latin1").endsWith("k\x00\x00\x00\x00"), 30_000);
    expect(Buffer.concat(got).toString("latin1")).toBe("a\x00\x00\x00\x03keyk\x00\x00\x00\x00");
    expect(lines.find((l) => l.ev === "orphan_kill")!.why).toBe("процесс old@laptop (pid 77) не в списке сессий — kill");
    expect(lines.some((l) => l.callsign === "chrome")).toBe(false);
    server.close();
    for (const c of sockets) c.destroy();
    const all = await journalUntil(h, (ls) => ls.some((l) => l.ev === "ready"), 60_000);
    const exited = all.filter((l) => l.ev === "session_exited");
    expect(String(exited[0].why)).toContain("держатель: держатель вышел с кодом 1");
    p.stdin.end();
    expect(await closed).toBe(0);
  }, 90_000);


  it("разделы модулей — из host.json, ключ машины — из machine.key: идут в hello", async () => {
    // источник: шапка main; устав «пропуск говорит флоту, кто пришёл»
    const hellos: string[] = [];
    const server = createHttpWs(hellos);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const code = 'export default { start(host) { host.log({ ev: "cfg", why: JSON.stringify(host.config()) }); } };\n';
    const main = release(["host-c"], { "host-c": { provides: {}, code } }, { relay: "http://127.0.0.1:" + port + "/", gate: "http://127.0.0.1:9/" });
    const h = home();
    writeFileSync(join(h, "host.json"), JSON.stringify({ modules: { "host-c": { a: 1 } } }));
    writeFileSync(join(h, "machine.key"), "host.laptop.k7.секрет\n");
    const p = spawn(process.execPath, [main], { env: { ...process.env, SWITCHBOARD_MACHINE: "laptop", SWITCHBOARD_HOME: h }, windowsHide: true });
    const closed = new Promise<number | null>((r) => p.on("close", (c) => r(c)));
    const lines = await journalUntil(h, (ls) => ls.some((l) => l.ev === "cfg") && hellos.length > 0, 30_000);
    expect(lines.find((l) => l.ev === "cfg")!.why).toBe('{"a":1}');
    expect(hellos[0]).toBe("host.laptop.k7.секрет");
    p.stdin.end();
    await closed;
    server.close();
  }, 90_000);

  it("738 · --check годного выпуска: ok, версия, SDK 0.3.311 и proto; код 0", async () => {
    // источник: устав «версия SDK закреплена точно»; ответ одной строкой JSON — чьё: код
    const r = await run(join(coreDir, "main.ts"), ["--check"], {});
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.trim())).toEqual({ ok: true, version: CORE_VERSION, sdk: "0.3.311", proto: PROTO });
  }, 90_000);

  it("739 · у имени два владельца: --check — ok:false с причиной, старт — «host: не стартует»; оба с кодом 1", async () => {
    // источник: устав «двое — Host не стартует»
    const main = release(["host-a", "host-b"], dup);
    const r = await run(main, ["--check"], {});
    expect(r.code).toBe(1);
    const x = JSON.parse(r.out.trim());
    expect(x.ok).toBe(false);
    expect(x.why).toContain("x.do: два владельца — host-a и host-b");
    const s = await run(main, [], { SWITCHBOARD_MACHINE: "laptop", SWITCHBOARD_HOME: home() });
    expect(s.code).toBe(1);
    expect(s.err).toContain("host: не стартует");
    expect(s.err).toContain("x.do: два владельца — host-a и host-b");
  }, 90_000);

  it("740 · папки модуля из списка сборки нет: --check — ok:false со словами, старт — «host:» с причиной; оба с кодом 1", async () => {
    // источник: устав «система ловит… отказывает, пишет причину»; дальше ведёт keeper
    const main = release(["host-nope"]);
    const r = await run(main, ["--check"], {});
    expect(r.code).toBe(1);
    const x = JSON.parse(r.out.trim());
    expect(x.ok).toBe(false);
    expect(x.why).toContain("host-nope");
    const s = await run(main, [], { SWITCHBOARD_MACHINE: "laptop", SWITCHBOARD_HOME: home() });
    expect(s.code).toBe(1);
    expect(s.err).toContain("host:");
    expect(s.err).toContain("host-nope");
  }, 90_000);

  it("--check: обработчик не из provides — ok:false с причиной: сборку с таким модулем не выпускают", async () => {
    // источник: устав «модуль, который не пройдёт, ловится гейтом»; чьё: код — гейт выпуска видит и устройство модуля
    const r = await run(release(["host-extra"], { "host-extra": { provides: {}, code: 'export default { requests: { "x.y": () => 1 } };\n' } }), ["--check"], {});
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out.trim()).why).toContain("host-extra: requests.x.y — нет в provides");
  }, 90_000);

  it("Host упал: ввод процесса не закрыт — настоящий SDK на выходе закрыл бы его, а сессия живёт у держателя", async () => {
    // источник: устав «держатели живут»; опыт на SDK 0.3.311 на Windows: без снятия соединений на выходе держатель получает кадр c
    const h = home();
    mkdirSync(join(h, "store"), { recursive: true });
    writeFileSync(join(h, "store", "core.json"), JSON.stringify({ sessions: [{ callsign: "site@laptop", session_id: "44444444-4444-4444-8444-444444444444", cwd: h, sdk: "0.3.311", stopped: false }] }));
    // держатель копит байты хозяина в файл и молчит: сессия стоит на initialize
    writeFileSync(join(h, "hold"), [
      'const fs = require("fs"), net = require("net");',
      'const s = net.createServer((c) => { c.on("error", () => {}); c.on("data", (d) => fs.appendFileSync("bytes", d.toString("latin1"), "latin1")); });',
      's.listen(0, "127.0.0.1", () => { console.log(JSON.stringify({ port: s.address().port, key: "k", pid: process.pid })); setTimeout(() => process.exit(0), 20000); });',
    ].join("\n"));
    // Host падает, как только держатель получил initialize: таймер заведён при импорте, ошибка ничья
    const code = 'import { existsSync, readFileSync } from "node:fs";\nconst t = setInterval(() => { if (!existsSync("bytes") || !readFileSync("bytes", "latin1").includes("initialize")) return; clearInterval(t); throw new Error("импорт упал"); }, 20);\nexport default {};\n';
    const main = release(["host-early"], { "host-early": { provides: {}, code } });
    const p = spawn(process.execPath, [main], { cwd: h, env: { ...process.env, SWITCHBOARD_MACHINE: "laptop", SWITCHBOARD_HOME: h, SWITCHBOARD_HOLDER: process.execPath }, windowsHide: true });
    const limit = setTimeout(() => p.kill(), 60_000);
    expect(await new Promise((r) => p.on("close", (c) => r(c)))).toBe(1);
    clearTimeout(limit);
    await new Promise((r) => setTimeout(r, 300));
    const bytes = readFileSync(join(h, "bytes"), "latin1");
    expect(bytes).toContain("initialize");
    expect(bytes.endsWith("c\x00\x00\x00\x00")).toBe(false);
  }, 90_000);

  it("741 · Host без SWITCHBOARD_MACHINE — отказ словами в stderr, код 1", async () => {
    // источник: устав «Host… часть машины, её запускает keeper»; слова — чьё: код
    const r = await run(join(coreDir, "main.ts"), [], { SWITCHBOARD_HOME: home() });
    expect(r.code).toBe(1);
    expect(r.err).toContain("host: нет SWITCHBOARD_MACHINE — Host запускает keeper");
  }, 90_000);


  it("752 · отказ промиса и бросок таймера, начатые модулем в start(), — модуль выключен на машине, процесс Host живёт", async () => {
    // источник: устав «часть падает и перезапускается одна», ветка «ошибка модуля — модуль выключен»; факт 2 нояб. — отказ фоновой цепочки модуля уронил весь Host
    const code = 'export default { start() { void Promise.reject(new Error("цепочка упала")); setTimeout(() => { throw new Error("таймер упал"); }, 50); } };\n';
    const main = release(["host-bad"], { "host-bad": { provides: {}, code } });
    const h = home();
    const e: Record<string, string | undefined> = { ...process.env, SWITCHBOARD_MACHINE: "laptop", SWITCHBOARD_HOME: h };
    delete e.SWITCHBOARD_RELAY;
    const p = spawn(process.execPath, [main], { env: e, windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    const closed = new Promise<number | null>((r) => p.on("close", (c) => r(c)));
    const lines = await journalUntil(h, (ls) => ls.some((l) => l.ev === "module_failed") && ls.some((l) => l.ev === "ready"), 30_000);
    // таймер бросает уже после выключения — процесс всё ещё жив
    await new Promise((r) => setTimeout(r, 500));
    expect(p.exitCode).toBeNull();
    // строка одна: бросок таймера после выключения второй строки не даёт
    const after = await journalUntil(h, () => false, 300);
    expect(after.filter((l) => l.ev === "module_failed")).toHaveLength(1);
    const failed = lines.find((l) => l.ev === "module_failed")!;
    expect(failed).toMatchObject({ module: "host-bad", word: "module_error" });
    expect(String(failed.why)).toContain("работа вне вызова ядра");
    expect(String(failed.why)).toContain("модуль выключен на машине");
    // штатный выход: ввод закрыт — код 0, а не 1
    p.stdin.end();
    expect(await closed).toBe(0);
    expect(err).not.toContain("цепочка упала");
  }, 90_000);

  it("5115 · модуль не импортировался, без default или его обработчик не из provides — модуль выключен на машине, Host готов", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): ошибка импорта или обработчик не из provides — модуль failed
    const main = release(["host-broken", "host-empty", "host-extra", "host-ok"], {
      "host-broken": { provides: {}, code: 'throw new Error("импорт сломан");\n' },
      "host-empty": { provides: {}, code: "export const x = 1;\n" },
      "host-extra": { provides: {}, code: 'export default { requests: { "x.y": () => 1 } };\n' },
      "host-ok": { provides: {} },
    });
    const h = home();
    const e: Record<string, string | undefined> = { ...process.env, SWITCHBOARD_MACHINE: "laptop", SWITCHBOARD_HOME: h };
    delete e.SWITCHBOARD_RELAY;
    const p = spawn(process.execPath, [main], { env: e, windowsHide: true });
    const closed = new Promise<number | null>((r) => p.on("close", (c) => r(c)));
    const lines = await journalUntil(h, (ls) => ls.some((l) => l.ev === "ready"), 30_000);
    const failed = lines.filter((l) => l.ev === "module_failed");
    expect(failed.map((l) => l.module).sort()).toEqual(["host-broken", "host-empty", "host-extra"]);
    expect(String(failed.find((l) => l.module === "host-broken")!.why)).toContain("импорт сломан");
    expect(String(failed.find((l) => l.module === "host-empty")!.why)).toContain("host-empty: импорт: нет default — объекта модуля");
    expect(String(failed.find((l) => l.module === "host-extra")!.why)).toContain("requests.x.y — нет в provides");
    expect(lines.find((l) => l.ev === "host_start")).toMatchObject({ version: "1.2.0+1", modules: ["host-broken 1.0.0", "host-empty 1.0.0", "host-extra 1.0.0", "host-ok 1.0.0"] });
    p.stdin.end();
    expect(await closed).toBe(0);
  }, 90_000);

  it("756 · таймер, заведённый модулем при импорте (до start), бросил — ошибка ничья: stderr и выход 1, module_failed нет", async () => {
    // источник: устав «чистый перезапуск компонента или процесса» и ветка «Host умер — один перезапуск» у keeper; чьё: код (main.ts — stray вернул false → выход 1)
    const code = 'setTimeout(() => { throw new Error("импорт упал"); }, 300);\nexport default {};\n';
    const main = release(["host-early"], { "host-early": { provides: {}, code } });
    const h = home();
    const r = await run(main, [], { SWITCHBOARD_MACHINE: "laptop", SWITCHBOARD_HOME: h });
    expect(r.code).toBe(1);
    expect(r.err).toContain("импорт упал");
    expect((await journalUntil(h, () => false, 0)).some((l) => l.ev === "module_failed")).toBe(false);
  }, 90_000);

});
