// Эталоны машины (дизайн «Файлы сессии», 5–14, 23, 24): номер эталона — номер теста. Хранилище — локальный сервер, служба файлов — подделка стенда.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { make as chat } from "../src/modules/chat/chat.ts";
import { make as files } from "../src/modules/files/files.ts";
import { make as incidents } from "../src/modules/incidents/incidents.ts";
import { stand, tick, until, type Stand } from "../stand/index.ts";

let st: Stand | undefined;
const servers: Server[] = [];
afterEach(async () => {
  await st?.stop();
  st = undefined;
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

const CS = "site@laptop";
const PULT = "pult~yuri@example.com", ANYA = "pult~anya@example.com";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const row = (cs: string) => st!.link.rows(cs).at(-1)!.row as any;
const journal = (msg: string) => st!.journal().filter((l) => l.msg === msg) as any[];
const feed = () => st!.link.of("session.events").flatMap((f) => f.events as any[]);

/** Хранилище флота: содержимое по хэшу. hang — имена хэшей, на которых сервер молчит; down — отвечает 500. */
async function storage(s: Stand) {
  const blobs = new Map<string, Buffer>();
  const store = { blobs, puts: [] as string[], gets: [] as string[], hang: new Set<string>(), down: false, url: "" };
  const srv = createServer((req, res) => {
    const hash = req.url!.split("/").pop()!;
    const parts: Buffer[] = [];
    req.on("data", (d: Buffer) => parts.push(d));
    req.on("end", () => {
      if (store.hang.has(hash)) return;
      if (store.down) return void res.writeHead(500).end();
      if (req.method === "PUT") {
        store.puts.push(hash);
        blobs.set(hash, Buffer.concat(parts));
        return void res.writeHead(200).end();
      }
      store.gets.push(hash);
      const body = blobs.get(hash);
      res.writeHead(body ? 200 : 404).end(body);
    });
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  store.url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  // служба файлов: ссылки на загрузку — только для хэшей, которых в хранилище нет
  s.services.handlers["files.put"] = (f) => ({ upload: Object.fromEntries((f.files as Array<{ hash: string }>).filter((x) => !blobs.has(x.hash)).map((x) => [x.hash, `${store.url}/b/${x.hash}`])) });
  s.services.handlers["files.get"] = (f) => ({ url: `${store.url}/b/${String(f.hash)}` });
  s.services.handlers["files.site"] = (f) => ({ url: `https://fleet.test/s/${String(f.site)}/` });
  return store;
}

/** Файл человека в хранилище — как его кладёт страница. */
const uploaded = (store: Awaited<ReturnType<typeof storage>>, name: string, body: string) => {
  store.blobs.set(sha(body), Buffer.from(body));
  return { name, hash: sha(body), size: Buffer.byteLength(body) };
};
const write = (dir: string, path: string, body: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), body);
};

describe("файлы: сессия отправляет файл", () => {
  it("эталон 5 · отправка out/a.svg: содержимое в хранилище; ответ — имя, хэш, размер; в журнале хэш, имя, размер", async () => {
    st = await stand({ modules: [chat(), files()] });
    const store = await storage(st);
    await st.open("site");
    const svg = "<svg xmlns='http://www.w3.org/2000/svg'/>";
    write(st.dir, "out/a.svg", svg);
    const r = await st.request("file.send", { to: CS, path: "out/a.svg", title: "График" }, CS);
    expect(r.result).toEqual({ name: "a.svg", hash: sha(svg), size: svg.length });
    expect(store.blobs.get(sha(svg))?.toString()).toBe(svg);
    expect(journal("file_send")).toMatchObject([{ callsign: CS, name: "a.svg", hash: sha(svg), size: svg.length, title: "График" }]);
    // путь — и полный: тот же файл, то же содержимое
    expect((await st.request("file.send", { to: CS, path: join(st.dir, "out", "a.svg") }, CS)).result).toMatchObject({ hash: sha(svg) });
  });

  it("эталон 6 · то же содержимое второй раз — загрузки нет", async () => {
    st = await stand({ modules: [chat(), files()] });
    const store = await storage(st);
    await st.open("site");
    write(st.dir, "a.txt", "одно и то же");
    write(st.dir, "копия.txt", "одно и то же");
    await st.request("file.send", { to: CS, path: "a.txt" }, CS);
    expect(store.puts).toHaveLength(1);
    expect((await st.request("file.send", { to: CS, path: "a.txt" }, CS)).ok).toBe(true);
    expect((await st.request("file.send", { to: CS, path: "копия.txt" }, CS)).result).toMatchObject({ name: "копия.txt", hash: sha("одно и то же") });
    expect(store.puts).toHaveLength(1);
  });

  it("эталон 7 · файла нет — no_file; to — чужой позывной — not_self: отказ словом сессии", async () => {
    st = await stand({ modules: [chat(), files()] });
    const store = await storage(st);
    await st.open("site");
    await st.open("docs");
    write(st.dir, "a.txt", "x");
    expect(await st.request("file.send", { to: CS, path: "нет.txt" }, CS)).toMatchObject({ ok: false, error: "no_file" });
    expect(await st.request("file.send", { to: CS, path: "." }, CS)).toMatchObject({ ok: false, error: "no_file" });
    expect(await st.request("file.send", { to: "docs@laptop", path: "a.txt" }, CS)).toMatchObject({ ok: false, error: "not_self" });
    expect(await st.request("file.send", { to: CS, path: "a.txt" }, PULT)).toMatchObject({ ok: false, error: "not_self" });
    expect(await st.request("site.publish", { to: "docs@laptop", dir: "." }, CS)).toMatchObject({ ok: false, error: "not_self" });
    expect(store.puts).toHaveLength(0);
  });
});

describe("файлы: человек загружает файл", () => {
  it("эталон 8 · сообщение человека с файлом: файл в uploads/ папки сессии, хэш сверен; сессии — текст и строка: путь, размер, хэш", async () => {
    st = await stand({ modules: [chat(), files()] });
    const store = await storage(st);
    const { proc } = await st.open("site");
    await st.request("session.watch", { to: CS }, PULT);
    const f = uploaded(store, "maket.png", "PNG-байты макета");
    expect((await st.request("message", { to: CS, text: "Вот макет, сверь с ним шапку.", files: [f] }, PULT)).ok).toBe(true);
    expect(readFileSync(join(st.dir, "uploads", "maket.png"), "utf8")).toBe("PNG-байты макета");
    await until(() => proc.inputs.length === 1, 5000, "ввод");
    expect(proc.inputs[0]!.message.content).toBe(`Вот макет, сверь с ним шапку.\n\nЗагружены файлы в папку сессии:\n- uploads/maket.png · ${f.size} байт · sha256 ${f.hash}`);
    // лента получает разобранное: текст человека без строки уведомления и файлы полем
    const said = await until(() => feed().find((e) => e.type === "user"), 5000, "событие ленты");
    expect(said).toMatchObject({ from: PULT, message: { content: "Вот макет, сверь с ним шапку." }, files: [f] });
    expect(journal("file_upload")).toMatchObject([{ callsign: CS, name: "uploads/maket.png", hash: f.hash, size: f.size }]);
    // из хранилища пришло не то содержимое — в папку не записано, сообщение не принято
    store.blobs.set("f".repeat(64), Buffer.from("подмена"));
    expect(await st.request("message", { to: CS, text: "ещё", files: [{ name: "b.bin", hash: "f".repeat(64), size: 7 }] }, PULT)).toMatchObject({ ok: false, error: "bad_file" });
    expect(readdirSync(join(st.dir, "uploads"))).toEqual(["maket.png"]);
    // файл от сессии — тем же шагом: строка уведомления внутри тега входящего
    const g = uploaded(store, "notes.md", "# заметки");
    await st.request("message", { to: CS, text: "держи", files: [g] }, "docs@server");
    await until(() => proc.inputs.length === 2, 5000, "ввод от сессии");
    expect(proc.inputs[1]!.message.content).toBe(`<fleet from="docs@server" kind="message">\nдержи\n\nЗагружены файлы в папку сессии:\n- uploads/notes.md · ${g.size} байт · sha256 ${g.hash}\n</fleet>`);
    expect(await until(() => feed().find((e) => e.peer), 5000, "входящее в ленте")).toMatchObject({ peer: { from: "docs@server", kind: "message", text: "держи" }, files: [g] });
  });

  it("эталон 9 · имя занято другим содержимым — файл встаёт рядом, с номером; то же содержимое — один файл", async () => {
    st = await stand({ modules: [chat(), files()] });
    const store = await storage(st);
    const { proc } = await st.open("site");
    const a = uploaded(store, "spec.pdf", "первая версия"), b = uploaded(store, "spec.pdf", "вторая версия");
    await st.request("message", { to: CS, text: "", files: [a] }, PULT);
    await st.request("message", { to: CS, text: "новая", files: [b] }, PULT);
    expect(readdirSync(join(st.dir, "uploads")).sort()).toEqual(["spec-2.pdf", "spec.pdf"]);
    expect(readFileSync(join(st.dir, "uploads", "spec-2.pdf"), "utf8")).toBe("вторая версия");
    // то же содержимое ещё раз — нового файла и нового чтения из хранилища нет
    const gets = store.gets.length;
    await st.request("message", { to: CS, text: "ещё раз", files: [b, a] }, PULT);
    expect(readdirSync(join(st.dir, "uploads")).sort()).toEqual(["spec-2.pdf", "spec.pdf"]);
    expect(store.gets).toHaveLength(gets);
    await until(() => proc.inputs.length === 3, 5000, "ввод");
    expect(proc.inputs[0]!.message.content).toBe(`Загружены файлы в папку сессии:\n- uploads/spec.pdf · ${a.size} байт · sha256 ${a.hash}`);
    expect(proc.inputs[2]!.message.content).toContain(`- uploads/spec-2.pdf · ${b.size} байт · sha256 ${b.hash}\n- uploads/spec.pdf · ${a.size} байт`);
    // имя с путём и знаками, которых не терпит диск, — только имя файла, внутри uploads/
    const c = uploaded(store, "../../etc/pass:wd", "x");
    await st.request("message", { to: CS, text: "", files: [c] }, PULT);
    expect(existsSync(join(st.dir, "uploads", "pass_wd"))).toBe(true);
  });

  it("эталон 10 · хранилище не ответило — сообщение не принято, отказ словом: во ввод ничего не ушло, человек не записан в участники", async () => {
    st = await stand({ modules: [chat(), files()] });
    const store = await storage(st);
    const { proc } = await st.open("site");
    const f = uploaded(store, "dump.bin", "дамп");
    store.down = true;
    const before = JSON.stringify(row(CS).people ?? []);
    expect(await st.request("message", { to: CS, text: "вот", files: [f] }, ANYA)).toMatchObject({ ok: false, error: "store_failed" });
    // служба файлов отказала словом — то же: сообщение не принято
    st.services.handlers["files.get"] = () => {
      throw { word: "no_file", message: "содержимого нет" };
    };
    expect(await st.request("message", { to: CS, text: "вот", files: [f] }, ANYA)).toMatchObject({ ok: false, error: "no_file" });
    await tick(10);
    expect(JSON.stringify(row(CS).people ?? [])).toBe(before);
    expect(proc.inputs).toHaveLength(0);
    expect(existsSync(join(st.dir, "uploads"))).toBe(false);
  });
});

describe("файлы: сессия поднимает сайт", () => {
  const site = (dir: string) => {
    write(dir, "out/site/index.html", "<h1>Отчёт</h1>");
    write(dir, "out/site/site.css", "h1 { color: teal }");
    write(dir, "out/site/js/app.js", "console.log(1)");
    write(dir, "out/site/.env", "секрет");
    write(dir, "out/site/node_modules/x/index.js", "чужое");
  };

  it("эталон 11 · сайт из папки out/site: список «путь → хэш» записан; ответ — адрес", async () => {
    st = await stand({ modules: [chat(), files()] });
    const store = await storage(st);
    await st.open("site");
    site(st.dir);
    const r = (await st.request("site.publish", { to: CS, dir: "out/site", title: "Отчёт за сутки" }, CS)).result as { url: string; files: number; size: number };
    const list = st.services.of("files.site")[0]! as any;
    expect(list.site).toMatch(/^[0-9a-f]{32}$/);
    // файлы с точки и node_modules в сайт не идут
    const size = (t: string) => Buffer.byteLength(t);
    const whole = size("<h1>Отчёт</h1>") + size("console.log(1)") + size("h1 { color: teal }");
    expect(list.files).toEqual([
      { path: "index.html", hash: sha("<h1>Отчёт</h1>"), size: size("<h1>Отчёт</h1>") },
      { path: "js/app.js", hash: sha("console.log(1)"), size: 14 },
      { path: "site.css", hash: sha("h1 { color: teal }"), size: 18 },
    ]);
    expect(r).toEqual({ url: `https://fleet.test/s/${list.site}/`, files: 3, size: whole });
    expect(store.puts.sort()).toEqual(list.files.map((f: { hash: string }) => f.hash).sort());
    expect(journal("site_publish")).toMatchObject([{ callsign: CS, site: list.site, files: 3, size: whole, sent: 3 }]);
  });

  it("эталон 12 · повтор с одним изменённым файлом и после очистки разговора: загружен 1 файл — число в строке журнала; адрес тот же", async () => {
    st = await stand({ modules: [chat(), files()] });
    const store = await storage(st);
    const { s } = await st.open("site");
    await st.open("docs");
    site(st.dir);
    const first = (await st.request("site.publish", { to: CS, dir: "out/site" }, CS)).result as { url: string };
    write(st.dir, "out/site/site.css", "h1 { color: navy }");
    // очистка разговора меняет его номер — адрес сайта от него не зависит
    s.rec.sessionId = "sid-после-очистки";
    const again = (await st.request("site.publish", { to: CS, dir: join(st.dir, "out", "site") }, CS)).result as { url: string };
    expect(again.url).toBe(first.url);
    expect(store.puts).toHaveLength(4);
    expect(store.puts.at(-1)).toBe(sha("h1 { color: navy }"));
    expect(journal("site_publish").map((l) => l.sent)).toEqual([3, 1]);
    // другая сессия и другая папка — другой адрес
    const other = (await st.request("site.publish", { to: "docs@laptop", dir: "out/site" }, "docs@laptop")).result as { url: string };
    write(st.dir, "out/second/index.html", "<p>второй</p>");
    const second = (await st.request("site.publish", { to: CS, dir: "out/second" }, CS)).result as { url: string };
    expect(new Set([first.url, other.url, second.url]).size).toBe(3);
  });

  it("эталон 13 · в папке нет index.html — отказ словом сессии", async () => {
    st = await stand({ modules: [chat(), files()] });
    const store = await storage(st);
    await st.open("site");
    write(st.dir, "out/site/site.css", "h1 {}");
    expect(await st.request("site.publish", { to: CS, dir: "out/site" }, CS)).toMatchObject({ ok: false, error: "no_index" });
    expect(await st.request("site.publish", { to: CS, dir: "нет-такой" }, CS)).toMatchObject({ ok: false, error: "no_index" });
    expect(store.puts).toHaveLength(0);
    expect(st.services.of("files.site")).toHaveLength(0);
  });
});

describe("файлы: обращение службы компьютера, история, предел", () => {
  it("эталон 14 · обращение службы компьютера с файлом: машина сразу кладёт файл в хранилище, в обращении — имя, хэш, размер; дальше тот же шаг: файл в папку и уведомление", async () => {
    st = await stand({ modules: [chat(), files(), incidents()], config: { "host-incidents": { port: 0 } } });
    const work = st.dir;
    const store = await storage(st);
    st.services.handlers["prefs.get"] = () => ({ values: { "incidents.kinds": { disk: { cwd: work } } } });
    st.link.deliver({ type: "changed", what: "incidents.kinds" });
    const port = ((await st.request("incident.list", { to: "@laptop" })).result as any).port as number;
    await tick(20);
    const res = await fetch(`http://127.0.0.1:${port}/incident`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "disk", key: "c:", text: "место кончается", files: [{ name: "df.txt", mime: "text/plain", base64: Buffer.from("/ 99%").toString("base64") }] }) });
    expect(res.status).toBe(202);
    const f = { name: "df.txt", hash: sha("/ 99%"), size: 5 };
    expect(store.blobs.get(f.hash)?.toString()).toBe("/ 99%");
    const proc = await until(() => st!.proc("disk-1@laptop"), 5000, "процесс инцидента");
    await until(() => proc.inputs.length === 1, 5000, "обращение во вводе");
    expect(proc.inputs[0]!.message.content).toBe(`<fleet from="@laptop" kind="incident" incident="disk" key="c:">\nместо кончается\n\nЗагружены файлы в папку сессии:\n- uploads/df.txt · 5 байт · sha256 ${f.hash}\n</fleet>`);
    expect(readFileSync(join(work, "uploads", "df.txt"), "utf8")).toBe("/ 99%");
    const list = ((await st.request("incident.list", { to: "@laptop" })).result as any).incidents as any[];
    expect(list[0]).toMatchObject({ kind: "disk", callsign: "disk-1@laptop", files: [f] });
    // своей папки вложений у обращений нет
    expect(existsSync(join(st.home, "incidents"))).toBe(false);
    // хранилище не ответило — обращение не принято, отказ словом службе
    store.down = true;
    const bad = await fetch(`http://127.0.0.1:${port}/incident`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "disk", key: "d:", text: "ещё", files: [{ name: "x.txt", base64: Buffer.from("новое").toString("base64") }] }) });
    expect([bad.status, ((await bad.json()) as { error: string }).error]).toEqual([400, "store_failed"]);
    expect(((await st.request("incident.list", { to: "@laptop" })).result as any).incidents).toHaveLength(1);
  });

  it("эталон 23 · история разговора: сообщение человека с файлом — текст человека без строки уведомления и те же имя, хэш, размер, что в ленте", async () => {
    st = await stand({ modules: [chat(), files()] });
    const store = await storage(st);
    const { proc } = await st.open("site");
    await st.request("session.watch", { to: CS }, PULT);
    const f = uploaded(store, "maket.png", "PNG-байты макета");
    await st.request("message", { to: CS, text: "Вот макет.", files: [f] }, PULT);
    await until(() => proc.inputs.length === 1, 5000, "ввод");
    // файл разговора хранит то, что ушло процессу: текст со строкой уведомления
    const said = [{ type: "user", uuid: "u1", message: { role: "user", content: proc.inputs[0]!.message.content } }, { type: "user", uuid: "u2", message: { role: "user", content: "А тут файлов нет:\n- список" } }];
    (st.sdk as any).functions = new Proxy({}, { get: (_t, name) => async () => (name === "getSessionMessages" ? said : {}) });
    const history = ((await st.request("session.history", { to: CS }, PULT)).result as { events: any[] }).events;
    expect(history[0]).toMatchObject({ uuid: "u1", message: { content: "Вот макет." }, files: [f] });
    expect(history[1]).toEqual(said[1]);
    const live = await until(() => feed().find((e) => e.type === "user"), 5000, "событие ленты");
    expect({ text: history[0].message.content, files: history[0].files }).toEqual({ text: live.message.content, files: live.files });
  });

  it("эталон 24 · действие с файлом дольше предела или машина останавливается: загрузка оборвана, отказ словом; повтор грузит только недостающее", async () => {
    st = await stand({ modules: [chat(), files({ limitMs: 300 })] });
    const store = await storage(st);
    await st.open("site");
    write(st.dir, "out/site/index.html", "<h1>Отчёт</h1>");
    write(st.dir, "out/site/z.css", "h1 { color: teal }");
    // второй файл хранилище не принимает: предел действия выходит
    store.hang.add(sha("h1 { color: teal }"));
    expect(await st.request("site.publish", { to: CS, dir: "out/site" }, CS)).toMatchObject({ ok: false, error: "timeout" });
    expect(store.puts).toEqual([sha("<h1>Отчёт</h1>")]);
    expect(st.services.of("files.site")).toHaveLength(0);
    // повтор: первый файл уже в хранилище — грузится только недостающий
    store.hang.clear();
    expect((await st.request("site.publish", { to: CS, dir: "out/site" }, CS)).ok).toBe(true);
    expect(store.puts).toEqual([sha("<h1>Отчёт</h1>"), sha("h1 { color: teal }")]);
    // машина останавливается посреди загрузки: загрузка оборвана, отказ словом
    write(st.dir, "big.bin", "большой файл");
    store.hang.add(sha("большой файл"));
    const sending = st.request("file.send", { to: CS, path: "big.bin" }, CS);
    await tick(20);
    void st.kernel.shutdown("эталон 24");
    expect(await sending).toMatchObject({ ok: false, error: "shutting_down" });
  });
});
