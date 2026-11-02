// Эталоны модуля parts на стенде Host: поддельные SDK, relay и держатели. «Выпуски» и keeper'ы машин отвечают
// через поддельный relay; ссылки R2 — подменённый fetch. Инструменты MCP зовутся обработчиком tool() сервера сессии.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { make } from "../src/parts.ts";
import { entries, pack } from "@switchboard/release";

const { module, standHost } = stand;
type Stand = stand.Stand;

const stands: Stand[] = [];
afterEach(async () => {
  for (const s of stands.splice(0)) await s.close();
  vi.restoreAllMocks();
});

type Answer = (f: Frame) => Record<string, unknown> | undefined;

/** Host машины laptop с модулем parts; serve отвечает на запросы, ушедшие в relay. Журнал машины — поддельный модуль. */
async function bench(serve: Answer) {
  const p = make();
  const journal = module("host-journal", {
    requests: { "machine.journal": (req) => ({ records: [{ part: req.part, machine: "laptop" }], more: false }) },
    start() {},
    stop() {},
  }, { provides: { "machine.journal": 2 } });
  const st = await standHost({ modules: [{ manifest: manifest as Manifest, module: p.module }, journal] });
  stands.push(st);
  const recv = st.relay.receive.bind(st.relay);
  st.relay.receive = (ws, text) => {
    recv(ws, text);
    const f = JSON.parse(text) as Frame;
    if (f.type === "hello" || f.type === "reply" || typeof f.id !== "string") return;
    const r = serve(f);
    if (r) queueMicrotask(() => st.relay.deliver({ type: "reply", id: f.id as string, from: f.to ?? "x", ...r } as Frame));
  };
  const call = async (name: string, args: Record<string, unknown>, cwd = tmpdir()) => {
    const t = p.tools(cwd).find((x) => x.name === name)!;
    const r = (await t.handler(args as never, {})) as { content: Array<{ text: string }>; isError?: boolean };
    return { ...r, text: r.content[0].text, json: () => JSON.parse(r.content[0].text) };
  };
  return { st, call };
}

const LISTED = {
  parts: { host: { where: "machine", edge: "1.1.58", stable: "1.1.57" }, capture: { where: "machine", edge: "1.5.0", stable: "1.4.0" } },
  machines: [
    { machine: "pc2", plan: { capture: { pin: "1.3.2" } } },
    { machine: "laptop", plan: {} },
  ],
  rev: 44,
};

describe("эталоны parts", () => {
  it("1 · list: каталог от .releases и состояние каждой машины от её keeper; закреплённая — с pin; keeper не ответил — error", async () => {
    const { st, call } = await bench((f) => {
      if (f.type === "releases.list") return { ok: true, result: LISTED };
      if (f.type === "keeper.state" && f.to === ".keeper@pc2")
        return { ok: true, result: { keeper: "0.6.0", rev: 44, os: "windows", parts: [{ part: "host", version: "1.1.57", state: "running" }, { part: "capture", version: "1.3.2", state: "running", pid: 9120 }] } };
      if (f.type === "keeper.state") return { ok: false, error: "offline" };
    });
    const r = await call("list", {});
    expect(r.isError).toBeUndefined();
    expect(r.json()).toEqual({
      parts: LISTED.parts,
      machines: [
        { machine: "pc2", keeper: "0.6.0", rev: 44, os: "windows", parts: [{ part: "host", version: "1.1.57", state: "running" }, { part: "capture", version: "1.3.2", state: "running", pid: 9120, pin: "1.3.2" }] },
        { machine: "laptop", error: "offline" },
      ],
    });
    expect(st.relay.sent.filter((f) => f.id).map((f) => [f.type, f.to])).toEqual([
      ["releases.list", ".releases"],
      ["keeper.state", ".keeper@pc2"],
      ["keeper.state", ".keeper@laptop"],
    ]);
  });

  it("2 · upload: модуль по module.json — две ссылки от «выпусков», архив и его хэш строкой sha256sum; без module.json — отказ без запроса", async () => {
    const dir = mkdtempSync(join(tmpdir(), "parts-app-"));
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "app", "module.json"), JSON.stringify({ name: "capture", type: "os", version: "1.4.0", provides: {}, uses: {}, config: {} }));
    writeFileSync(join(dir, "app", "app.json"), '{ "run": ["node", "main.js"] }');
    writeFileSync(join(dir, "app", "main.js"), "process.stdin.resume();");
    const { st, call } = await bench((f) => (f.type === "releases.upload" ? { ok: true, result: { tgz: "https://r2.test/b/capture/1.4.0.tgz?sig", sha256: "https://r2.test/b/capture/1.4.0.sha256?sig" } } : undefined));
    const puts: Array<{ url: string; body: Buffer }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
      puts.push({ url: String(u), body: Buffer.from(init!.body as Uint8Array) });
      return new Response("", { status: 200 });
    });
    expect((await call("upload", { dir: "." }, dir)).text).toMatch(/^no_module_json/);
    expect(st.relay.sent.filter((f) => f.type === "releases.upload")).toEqual([]);
    const r = await call("upload", { dir: "app" }, dir);
    expect(r.isError).toBeUndefined();
    const sha = createHash("sha256").update(puts[0].body).digest("hex");
    expect(r.json()).toEqual({ part: "capture", version: "1.4.0", bytes: puts[0].body.length, sha256: sha });
    expect(puts.map((p) => p.url)).toEqual(["https://r2.test/b/capture/1.4.0.tgz?sig", "https://r2.test/b/capture/1.4.0.sha256?sig"]);
    expect(puts[1].body.toString()).toBe(`${sha}  1.4.0.tgz\n`);
    expect(gunzipSync(puts[0].body).toString("latin1")).toContain("app.json");
    expect(st.relay.sent.find((f) => f.type === "releases.upload")).toMatchObject({ to: ".releases", part: "capture", version: "1.4.0", sha256: sha });
  });

  it("5145 · upload: тот же архив уже лежит — «выпуски» отвечают same, PUT нет", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): загрузка по ссылкам «Выпусков» — одна функция у parts.upload и CI
    const dir = mkdtempSync(join(tmpdir(), "parts-app-"));
    writeFileSync(join(dir, "app.json"), "{}");
    writeFileSync(join(dir, "module.json"), JSON.stringify({ name: "capture", type: "os", version: "1.4.0", provides: {}, uses: {}, config: {} }));
    const { call } = await bench((f) => (f.type === "releases.upload" ? { ok: true, result: { same: true } } : undefined));
    const puts: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => (puts.push(String(url)), new Response("", { status: 200 })));
    const r = await call("upload", { dir: "." }, dir);
    expect(r.json()).toMatchObject({ part: "capture", version: "1.4.0", same: true });
    expect(puts).toEqual([]);
  });

  it("5191 · upload модуля чужого репо по его module.json: модуль Host — файлы пакета, страницы — его module.js, Worker — имена по флотам из wrangler, приложение ОС — dist/; module.json первым", async () => {
    // источник: отчёт слепого архитектора 2 нояб.: пункт 12 — одна упаковка «папка модуля → архив» у parts.upload и release-cli
    const root = mkdtempSync(join(tmpdir(), "parts-repo-"));
    const mod = (name: string, type: string, files: Record<string, string>) => {
      const d = join(root, name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "module.json"), JSON.stringify({ name, type, version: "0.1.0", provides: {}, uses: {}, config: {} }));
      for (const [p, s] of Object.entries(files)) {
        mkdirSync(join(d, p, ".."), { recursive: true });
        writeFileSync(join(d, p), s);
      }
    };
    mod("hello-host", "sdk", { "contract.ts": "export default {};", "src/a.ts": "export {};", "test/a.test.ts": "x" });
    mod("hello-tab", "web", { "module.js": "export default {};", "contract.ts": "export {};" });
    mod("hello-worker", "worker", { "wrangler.jsonc": '// w\n{ "name": "hello-worker", "env": { "prod": {} } }', "src/index.ts": "x" });
    mod("hello-daemon", "os", { "app.json": "{}", "dist/app.json": '{"run":["node","d.mjs"]}', "dist/d.mjs": "1" });
    mod("bad-tab", "web", { "contract.ts": "x" });
    const { st, call } = await bench((f) => (f.type === "releases.upload" ? { ok: true, result: { tgz: `https://r2.test/${f.part}.tgz`, sha256: `https://r2.test/${f.part}.sha256` } } : undefined));
    const tgz = new Map<string, Buffer>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
      const url = String(u);
      if (url.endsWith(".tgz")) tgz.set(url.slice("https://r2.test/".length, -4), Buffer.from(init!.body as Uint8Array));
      return new Response("", { status: 200 });
    });
    for (const n of ["hello-host", "hello-tab", "hello-worker", "hello-daemon"]) expect((await call("upload", { dir: n }, root)).json()).toMatchObject({ part: n, version: "0.1.0" });
    const paths = (n: string) => entries(tgz.get(n)!).filter((e) => e.data).map((e) => e.path);
    expect(paths("hello-host")).toEqual(["module.json", "contract.ts", "src/a.ts"]);
    expect(paths("hello-tab")).toEqual(["module.json", "contract.ts", "module.js"]);
    expect(paths("hello-worker")).toEqual(["module.json"]);
    expect(JSON.parse(entries(tgz.get("hello-worker")!)[0].data!.toString("utf8")).workers).toEqual({ test: "hello-worker", prod: "hello-worker-prod" });
    expect(paths("hello-daemon")).toEqual(["module.json", "app.json", "d.mjs"]);
    const bad = await call("upload", { dir: "bad-tab" }, root);
    expect([bad.isError, bad.text]).toEqual([true, "bad-tab: у модуля страницы нет module.js — собери его одним файлом"]);
    expect(st.relay.sent.filter((f) => f.type === "releases.upload").map((f) => f.part)).toEqual(["hello-host", "hello-tab", "hello-worker", "hello-daemon"]);
  });

  it("5196 · upload: номер занят архивом с тем же tar и другим сжатием — releases.fetch, сравнение без сжатия, same без PUT", async () => {
    // источник: живой факт 2 нояб.: gzip даёт разные байты на разных машинах при том же tar — «подними номер» на том же модуле
    const dir = mkdtempSync(join(tmpdir(), "parts-app-"));
    writeFileSync(join(dir, "app.json"), "{}");
    writeFileSync(join(dir, "module.json"), JSON.stringify({ name: "capture", type: "os", version: "1.4.0", provides: {}, uses: {}, config: {} }));
    const { gunzipSync, gzipSync } = await import("node:zlib");
    const { packModule } = await import("@switchboard/release");
    const lying = gzipSync(gunzipSync(packModule(dir).tgz), { level: 1 });
    const { st, call } = await bench((f) =>
      f.type === "releases.upload" ? { ok: false, error: "version_exists" } : f.type === "releases.fetch" ? { ok: true, result: { version: "1.4.0", url: "https://r2.test/capture/1.4.0.tgz?s" } } : undefined,
    );
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => (seen.push(`${init?.method ?? "GET"} ${String(u)}`), new Response(lying, { status: 200 })));
    expect((await call("upload", { dir: "." }, dir)).json()).toMatchObject({ part: "capture", version: "1.4.0", same: true });
    expect(seen).toEqual(["GET https://r2.test/capture/1.4.0.tgz?s"]);
    expect(st.relay.sent.filter((f) => f.type === "releases.fetch").map((f) => [f.part, f.version])).toEqual([["capture", "1.4.0"]]);
  });

  it("3 · deploy и set — на .releases как есть, даже с полем machine; отказ — словом с ошибкой", async () => {
    const { st, call } = await bench((f) => {
      if (f.type === "releases.deploy") return { ok: true, result: { parts: { host: { from: "1.1.58", to: "1.1.57" } } } };
      if (f.type === "releases.set") return f.part === "probe" ? { ok: false, error: "no_release" } : { ok: true, result: { machine: "wsl", rev: 45 } };
    });
    expect((await call("deploy", { part: "host", version: "1.1.57" })).json()).toEqual({ parts: { host: { from: "1.1.58", to: "1.1.57" } } });
    expect((await call("set", { machine: "wsl", part: "host", pin: "1.1.58" })).json()).toEqual({ machine: "wsl", rev: 45 });
    const no = await call("set", { machine: "wsl", part: "probe", on: true });
    expect([no.isError, no.text]).toEqual([true, "releases.set: no_release"]);
    expect(st.relay.sent.filter((f) => f.id).map(({ id: _i, ...f }) => f)).toEqual([
      { type: "releases.deploy", v: 1, to: ".releases", part: "host", version: "1.1.57" },
      { type: "releases.set", v: 1, to: ".releases", machine: "wsl", part: "host", pin: "1.1.58" },
      { type: "releases.set", v: 1, to: ".releases", machine: "wsl", part: "probe", on: true },
    ]);
  });

  it("4 · log: своя машина — журнал машины здесь, чужая — запрос machine.journal её Host с отбором part", async () => {
    const { st, call } = await bench((f) => (f.type === "machine.journal" ? { ok: true, result: { records: [{ part: f.part, machine: f.machine }], more: false } } : undefined));
    expect((await call("log", { machine: "laptop", part: "capture", since: "2026-11-01T10:00:00Z" })).json()).toEqual({ records: [{ part: "capture", machine: "laptop" }], more: false });
    expect((await call("log", { machine: "win", part: "host", limit: 5 })).json()).toEqual({ records: [{ part: "host", machine: "win" }], more: false });
    expect(st.relay.sent.filter((f) => f.type === "machine.journal").map(({ id: _i, since: _s, ...f }) => f)).toEqual([{ type: "machine.journal", v: 2, machine: "win", part: "host", limit: 5 }]);
  });
});

describe("parts: покрытие плана host-modules", () => {
  it("3073 · list: «выпуски» отказали — текст ошибки, keeper не спрашивали", async () => {
    // источник: чьё: код (parts.ts:19, :35)
    const { st, call } = await bench((f) => (f.type === "releases.list" ? { ok: false, error: "no_access" } : undefined));
    const r = await call("list", {});
    expect([r.isError, r.text]).toEqual([true, "releases.list: no_access"]);
    expect(st.relay.sent.filter((f) => f.type === "keeper.state")).toEqual([]);
  });

  it("3074 · upload: releases.upload отказал; R2 ответил 403 — текст ошибки", async () => {
    // источник: чьё: код (parts.ts:61, :69-70)
    const dir = mkdtempSync(join(tmpdir(), "parts-app-"));
    writeFileSync(join(dir, "app.json"), "{}");
    writeFileSync(join(dir, "module.json"), JSON.stringify({ name: "capture", type: "os", version: "1.4.0", provides: {}, uses: {}, config: {} }));
    let refuse = true;
    const { call } = await bench((f) => (f.type === "releases.upload" ? (refuse ? { ok: false, error: "exists" } : { ok: true, result: { tgz: "https://r2.test/a.tgz?s", sha256: "https://r2.test/a.sha256?s" } }) : undefined));
    const a = await call("upload", { dir: "." }, dir);
    expect([a.isError, a.text]).toEqual([true, "releases.upload: exists"]);
    refuse = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 403 }));
    const b = await call("upload", { dir: "." }, dir);
    expect([b.isError, b.text]).toEqual([true, "upload_failed: R2 ответил 403 на /a.tgz"]);
  });

  it("3152 · upload: R2 держит PUT и не отвечает — за 10 мин текст upload_failed с причиной, хэш не пишется", async () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»; предел — как у keeper на скачивание архива части
    const dir = mkdtempSync(join(tmpdir(), "parts-app-"));
    writeFileSync(join(dir, "app.json"), "{}");
    writeFileSync(join(dir, "module.json"), JSON.stringify({ name: "capture", type: "os", version: "1.4.2", provides: {}, uses: {}, config: {} }));
    const { call } = await bench((f) => (f.type === "releases.upload" ? { ok: true, result: { tgz: "https://r2.test/a.tgz?s", sha256: "https://r2.test/a.sha256?s" } } : undefined));
    const puts: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((u: RequestInfo | URL, init?: RequestInit) => {
      puts.push(String(u));
      return new Promise((_ok, no) => init?.signal?.addEventListener("abort", () => no(new Error("aborted"))));
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = call("upload", { dir: "." }, dir);
      await vi.waitFor(() => expect(puts).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      const r = await pending;
      expect([r.isError, r.text]).toEqual([true, "upload_failed: R2 не ответил за 10 мин на /a.tgz"]);
      expect(puts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("3075 · deploy: без версии — edge, отказ — текст ошибки; set: pin null уходит как есть", async () => {
    // источник: чьё: код (parts.ts:79-82, :96-99)
    const { st, call } = await bench((f) => {
      if (f.type === "releases.deploy") return { ok: false, error: "no_version" };
      if (f.type === "releases.set") return { ok: true, result: { machine: "wsl", rev: 46 } };
    });
    const d = await call("deploy", { part: "*" });
    expect([d.isError, d.text]).toEqual([true, "releases.deploy: no_version"]);
    await call("set", { machine: "wsl", part: "host", pin: null });
    expect(st.relay.sent.filter((f) => f.id).map(({ id: _i, ...f }) => f)).toEqual([
      { type: "releases.deploy", v: 1, to: ".releases", part: "*" },
      { type: "releases.set", v: 1, to: ".releases", machine: "wsl", part: "host", pin: null },
    ]);
  });

  it("3076 · log: по умолчанию — последний час и 50 строк; Host машины мёртв — текст ошибки", async () => {
    // источник: чьё: код (parts.ts:107-112)
    const { st, call } = await bench((f) => (f.type === "machine.journal" ? { ok: false, error: "offline" } : undefined));
    const before = Date.now();
    const r = await call("log", { machine: "win", part: "host" });
    expect([r.isError, r.text]).toEqual([true, "machine.journal: offline"]);
    const q = st.relay.frames("machine.journal")[0];
    expect(q).toMatchObject({ machine: "win", part: "host", limit: 50 });
    const since = Date.parse(q.since as string);
    expect(before - since).toBeGreaterThanOrEqual(3600_000 - 1000);
    expect(before - since).toBeLessThanOrEqual(3600_000 + 1000);
  });
});

describe("parts.fetch", () => {
  // источник всех эталонов блока: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): инструмент сессии
  // parts.fetch кладёт контракт и стенд в vendor/ репо
  const tgz = pack([
    { path: "module.json", data: Buffer.from('{"name":"web-card","version":"1.1.0","type":"web"}') },
    { path: "contract.ts", data: Buffer.from("export {};\n") },
    { path: "stand/app.ts", data: Buffer.from("export const stand = 1;\n") },
  ]);

  it("5164 · ссылка от releases.fetch, архив — в <dir>/vendor/<part>/: module.json, контракт, стенд; прежнее содержимое заменено", async () => {
    const repo = mkdtempSync(join(tmpdir(), "parts-repo-"));
    mkdirSync(join(repo, "vendor", "web-card"), { recursive: true });
    writeFileSync(join(repo, "vendor", "web-card", "old.ts"), "старое");
    const { st, call } = await bench((f) => (f.type === "releases.fetch" ? { ok: true, result: { version: "1.1.0", url: "https://r2.test/b/web-card/1.1.0.tgz?sig" } } : undefined));
    const got: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => (got.push(String(u)), new Response(new Uint8Array(tgz), { status: 200 })));
    const r = await call("fetch", { part: "web-card", dir: "." }, repo);
    expect(r.isError).toBeUndefined();
    expect(r.json()).toEqual({ part: "web-card", version: "1.1.0", dir: join(repo, "vendor", "web-card"), files: ["module.json", "contract.ts", "stand/app.ts"] });
    expect(got).toEqual(["https://r2.test/b/web-card/1.1.0.tgz?sig"]);
    expect(readFileSync(join(repo, "vendor", "web-card", "stand", "app.ts"), "utf8")).toBe("export const stand = 1;\n");
    expect(existsSync(join(repo, "vendor", "web-card", "old.ts"))).toBe(false);
    expect(st.relay.sent.find((f) => f.type === "releases.fetch")).toMatchObject({ to: ".releases", part: "web-card" });
  });

  it("5165 · releases.fetch отказал — текст ошибки, R2 не спрашивали; R2 ответил 404 — fetch_failed, vendor не тронут", async () => {
    const repo = mkdtempSync(join(tmpdir(), "parts-repo-"));
    let answer: Record<string, unknown> = { ok: false, error: "no_release" };
    const { call } = await bench((f) => (f.type === "releases.fetch" ? answer : undefined));
    const got: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => (got.push(String(u)), new Response("", { status: 404 })));
    const a = await call("fetch", { part: "nobody", dir: "." }, repo);
    expect([a.isError, a.text]).toEqual([true, "releases.fetch: no_release"]);
    expect(got).toEqual([]);
    answer = { ok: true, result: { version: "1.0.0", url: "https://r2.test/x.tgz?s" } };
    const b = await call("fetch", { part: "x", version: "1.0.0", dir: "." }, repo);
    expect([b.isError, b.text]).toEqual([true, "fetch_failed: R2 ответил 404 на x 1.0.0"]);
    expect(existsSync(join(repo, "vendor"))).toBe(false);
  });

  it("5166 · R2 держит ответ — за 10 мин текст fetch_failed с причиной", async () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»; предел — как у загрузки
    const repo = mkdtempSync(join(tmpdir(), "parts-repo-"));
    const { call } = await bench((f) => (f.type === "releases.fetch" ? { ok: true, result: { version: "1.0.0", url: "https://r2.test/x.tgz?s" } } : undefined));
    const got: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((u: RequestInfo | URL, init?: RequestInit) => {
      got.push(String(u));
      return new Promise((_ok, no) => init?.signal?.addEventListener("abort", () => no(new Error("aborted"))));
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = call("fetch", { part: "x", dir: "." }, repo);
      await vi.waitFor(() => expect(got).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      const r = await pending;
      expect([r.isError, r.text]).toEqual([true, "fetch_failed: R2 не ответил за 10 мин на x 1.0.0"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
