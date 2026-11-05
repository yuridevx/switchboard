// Сервер дизайна и слежение: настоящие serve.mjs и watch.mjs на временной папке дизайна. Без прода: страница дизайна без мока
// и приложение без частей стенда до связи не доходят. Номер — эталон дизайна «Прототип на настоящем фронте».
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const procs: ChildProcess[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill();
});

function run(script: string, args: string[]) {
  const p = spawn(process.execPath, [path.join(here, script), ...args], { stdio: ["ignore", "pipe", "pipe"] });
  procs.push(p);
  let out = "";
  let err = "";
  p.stdout!.on("data", (c) => (out += c));
  p.stderr!.on("data", (c) => (err += c));
  const exit = new Promise<number>((ok) => p.on("exit", (code) => ok(code ?? -1)));
  const line = (re: RegExp) => new Promise<void>((ok) => { const t = setInterval(() => re.test(out) && (clearInterval(t), ok()), 20); });
  return { exit, line, out: () => out, err: () => err };
}

const folder = (files: Record<string, string>) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "design-"));
  for (const [n, v] of Object.entries(files)) fs.writeFileSync(path.join(d, n), v);
  return d;
};

describe("сервер дизайна", () => {
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
