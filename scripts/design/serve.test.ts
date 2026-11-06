// Сервер дизайна и слежение: настоящие serve.mjs и watch.mjs на временной папке дизайна; флот — поддельный gate и relay на localhost. Без прода: страница дизайна без мока
// и приложение без частей стенда до связи не доходят. Номер — эталон дизайна «Прототип на настоящем фронте».
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const procs: ChildProcess[] = [];
const servers: http.Server[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill();
  for (const s of servers.splice(0)) s.close();
});

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const p = spawn(process.execPath, [path.join(here, script), ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  procs.push(p);
  let out = "";
  let err = "";
  p.stdout!.on("data", (c) => (out += c));
  p.stderr!.on("data", (c) => (err += c));
  const exit = new Promise<number>((ok) => p.on("exit", (code) => ok(code ?? -1)));
  const line = (re: RegExp) => new Promise<void>((ok) => { const t = setInterval(() => re.test(out) && (clearInterval(t), ok()), 20); });
  return { exit, line, out: () => out, err: () => err, kill: (sig: NodeJS.Signals) => p.kill(sig) };
}

/** Поддельный флот: gate и relay одним адресом; копит типы кадров, живые пропуска — по приглашениям. */
async function fakeFleet() {
  const asked: string[] = [];
  const passes: Array<{ id: string; role: string; name: string; addr: string }> = [];
  const answer = (f: Record<string, unknown>) => {
    if (f.type === "keys.invite") {
      passes.push({ id: `k${passes.length}`, role: "client", name: String(f.name), addr: `${f.name}~a@b` });
      return { invite: `k${passes.length - 1}.code` };
    }
    if (f.type === "keys.revoke") passes.splice(passes.findIndex((p) => p.id === f.kid), 1);
    return { passes, you: "agent~a@b" };
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const f = JSON.parse(body);
      asked.push(f.type);
      res.end(JSON.stringify({ ok: true, result: answer(f) }));
    });
  });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const dev = fs.mkdtempSync(path.join(os.tmpdir(), "dev-"));
  for (const n of ["test", "prod"]) fs.writeFileSync(path.join(dev, `${n}-agent.pass`), "agent.pass");
  return { asked, passes, env: { SWITCHBOARD_WORKERS: JSON.stringify({ gate: url, relay: url }), SWITCHBOARD_DEV_DIR: dev } };
}

/** События страницы: первый кадр с именем name. */
async function firstEvent(url: string, name: string) {
  const r = await fetch(url);
  const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  for (;;) {
    const { value } = await reader.read();
    text += value;
    const m = new RegExp(`event: ${name}\ndata: (.*)\n`).exec(text);
    if (m) {
      void reader.cancel().catch(() => {});
      return JSON.parse(m[1]);
    }
  }
}

const folder = (files: Record<string, string>) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "design-"));
  for (const [n, v] of Object.entries(files)) fs.writeFileSync(path.join(d, n), v);
  return d;
};

describe("сервер дизайна", () => {
  it("фронт 1 · мока нет, флот не назван — сервер не стартует, отказ словом", async () => {
    const s = run("serve.mjs", [folder({}), "4893", "--app", "pult"]);
    expect(await s.exit).toBe(1);
    expect(s.err()).toMatch(/^no_mock: /);
    expect(s.out()).toBe("");
  });

  it("фронт 5 · порт занят — отказ словом, к выдаче пропусков ни одного кадра", async () => {
    const fleet = await fakeFleet();
    const busy = http.createServer();
    servers.push(busy);
    await new Promise<void>((ok) => busy.listen(4894, "127.0.0.1", ok));
    const s = run("serve.mjs", ["--fleet", "test", "--port", "4894"], fleet.env);
    expect(await s.exit).toBe(1);
    expect(s.err()).toMatch(/^port_taken: порт 4894/);
    expect(fleet.asked).toEqual([]);
  });

  it("фронт 6, 8 · прод без мока — ссылка человеку есть, агенту нет; разделы телефона — как в сборке", async () => {
    const fleet = await fakeFleet();
    const s = run("serve.mjs", ["--fleet", "prod", "--port", "4895", "--app", "phone"], fleet.env);
    await s.line(/в чат: http/);
    expect(s.out()).toContain("фронт: прод");
    expect(s.out()).not.toContain("снимки:");
    expect(fleet.passes.map((p) => p.name)).toEqual(["design-front-prod-4895"]);
    const page = await (await fetch("http://localhost:4895/app/phone/")).text();
    expect(page).toContain("<title>phone · прод</title>");
    const bundle = await (await fetch("http://localhost:4895/app/phone/bundle.js")).text();
    expect(bundle).toContain(`sections: ["inbox", "board", "accounts", "profiles", "incidents", "settings"]`);
  });

  it("фронт 4 · правка файла — кадр reload; файл с ошибкой — кадр fail с причиной, страница на прежней сборке", async () => {
    const fleet = await fakeFleet();
    const d = folder({ "mock.ts": "export default {};" });
    const s = run("serve.mjs", [d, "4896", "--fleet", "test"], fleet.env);
    await s.line(/снимки: http/);
    const events = "http://localhost:4896/app/pult/events";
    const before = await (await fetch("http://localhost:4896/app/pult/bundle.js")).text();
    const reload = firstEvent(events, "reload");
    await new Promise((ok) => setTimeout(ok, 200));
    fs.writeFileSync(path.join(d, "mock.ts"), 'export default { owns: ["edited.once"] };');
    expect(await reload).toBe("pult");
    const edited = await (await fetch("http://localhost:4896/app/pult/bundle.js")).text();
    expect(edited).toContain("edited.once");
    const broken = firstEvent(events, "fail");
    await new Promise((ok) => setTimeout(ok, 200));
    fs.writeFileSync(path.join(d, "mock.ts"), "export default {");
    expect(await broken).toMatch(/Expected/);
    expect(await (await fetch("http://localhost:4896/app/pult/bundle.js")).text()).toBe(edited);
    expect(edited).not.toBe(before);
  });

  // на Windows сигнала нет: kill снимает процесс сразу, штатная ветка идёт в CI на Linux
  it.skipIf(process.platform === "win32")("фронт 9 · сигнал остановки при открытой странице — пропуска отозваны, выход штатный", async () => {
    const fleet = await fakeFleet();
    const s = run("serve.mjs", ["--fleet", "test", "--port", "4897"], fleet.env);
    await s.line(/снимки: http/);
    expect(fleet.passes).toHaveLength(2);
    const open = await fetch("http://localhost:4897/app/pult/events");
    s.kill("SIGTERM");
    expect(await s.exit).toBe(0);
    expect(fleet.passes).toEqual([]);
    await open.body!.cancel();
  });

  it("6 · приложение без stand/parts.ts — отказ словом с подсказкой, сервер не стартует", async () => {
    const d = folder({ "mock.ts": "export default {};" });
    const s = run("serve.mjs", [d, "4891", "--app", "nope"]);
    expect(await s.exit).toBe(1);
    expect(s.err()).toMatch(/^no_stand: нет web\/nope\/stand\/parts\.ts с export function nopeParts\(\).*по образцу web\/pult\/stand\/parts\.ts/);
    expect(s.out()).toBe("");
  });

  it("5 · комментарий к блоку и к элементу — две записи одной формы в notes.json; watch.mjs печатает каждую и выходит", async () => {
    const d = folder({ "index.html": "<section data-chg=\"b1\">блок</section>" });
    const port = 4892;
    const s = run("serve.mjs", [d, String(port)]);
    await s.line(/дизайн: http/);
    expect(await (await fetch(`http://localhost:${port}/`)).text()).toContain('<section data-chg="b1">');
    const post = (b: unknown) => fetch(`http://localhost:${port}/api/comment`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.json());
    const toBlock = { text: "почему не событие?", where: { page: "doc", block: "b1" } };
    const toElement = { text: "на прототипе скрой", where: { page: "app:pult", hash: "#sessions", selector: "div.al-card", element: "Включить уведомления", w: 1280, theme: "light" } };

    for (const c of [toBlock, toElement]) {
      const w = run("watch.mjs", [d, "1"]);
      await new Promise((ok) => setTimeout(ok, 800));
      await post(c);
      expect(await w.exit).toBe(0);
      expect(JSON.parse(w.out().trim())).toMatchObject(c);
    }
    const notes = JSON.parse(fs.readFileSync(path.join(d, "notes.json"), "utf8"));
    expect(notes.comments).toHaveLength(2);
    expect(notes.comments.map((c: object) => Object.keys(c).sort())).toEqual([["at", "id", "text", "where"], ["at", "id", "text", "where"]]);
  });
});
