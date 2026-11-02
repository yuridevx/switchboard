// Эталоны модуля parts на стенде Host: поддельные SDK, relay и держатели. «Выпуски» и keeper'ы машин отвечают
// через поддельный relay; ссылки R2 — подменённый fetch. Инструменты MCP зовутся обработчиком tool() сервера сессии.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { make } from "../src/parts.ts";

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

  it("2 · upload: две ссылки от «выпусков», архив с app.json и его хэш строкой sha256sum; без app.json — отказ без запроса", async () => {
    const dir = mkdtempSync(join(tmpdir(), "parts-app-"));
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "app", "app.json"), '{ "run": ["node", "main.js"] }');
    writeFileSync(join(dir, "app", "main.js"), "process.stdin.resume();");
    const { st, call } = await bench((f) => (f.type === "releases.upload" ? { ok: true, result: { tgz: "https://r2.test/b/capture/1.4.0.tgz?sig", sha256: "https://r2.test/b/capture/1.4.0.sha256?sig" } } : undefined));
    const puts: Array<{ url: string; body: Buffer }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
      puts.push({ url: String(u), body: Buffer.from(init!.body as Uint8Array) });
      return new Response("", { status: 200 });
    });
    expect((await call("upload", { part: "capture", version: "1.4.0", dir: "." }, dir)).text).toMatch(/^no_app_json/);
    expect(st.relay.sent.filter((f) => f.type === "releases.upload")).toEqual([]);
    const r = await call("upload", { part: "capture", version: "1.4.0", dir: "app" }, dir);
    expect(r.isError).toBeUndefined();
    const sha = createHash("sha256").update(puts[0].body).digest("hex");
    expect(r.json()).toEqual({ part: "capture", version: "1.4.0", bytes: puts[0].body.length, sha256: sha });
    expect(puts.map((p) => p.url)).toEqual(["https://r2.test/b/capture/1.4.0.tgz?sig", "https://r2.test/b/capture/1.4.0.sha256?sig"]);
    expect(puts[1].body.toString()).toBe(`${sha}  1.4.0.tgz\n`);
    expect(gunzipSync(puts[0].body).toString("latin1")).toContain("app.json");
    expect(st.relay.sent.find((f) => f.type === "releases.upload")).toMatchObject({ to: ".releases", part: "capture", version: "1.4.0" });
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
    let refuse = true;
    const { call } = await bench((f) => (f.type === "releases.upload" ? (refuse ? { ok: false, error: "exists" } : { ok: true, result: { tgz: "https://r2.test/a.tgz?s", sha256: "https://r2.test/a.sha256?s" } }) : undefined));
    const a = await call("upload", { part: "capture", version: "1.4.0", dir: "." }, dir);
    expect([a.isError, a.text]).toEqual([true, "releases.upload: exists"]);
    refuse = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 403 }));
    const b = await call("upload", { part: "capture", version: "1.4.1", dir: "." }, dir);
    expect([b.isError, b.text]).toEqual([true, "upload_failed: R2 ответил 403 на /a.tgz"]);
  });

  it("3152 · upload: R2 держит PUT и не отвечает — за 10 мин текст upload_failed с причиной, хэш не пишется", async () => {
    // источник: слово пользователя 2 нояб. «у всех операций должен быть лимит»; предел — как у keeper на скачивание архива части
    const dir = mkdtempSync(join(tmpdir(), "parts-app-"));
    writeFileSync(join(dir, "app.json"), "{}");
    const { call } = await bench((f) => (f.type === "releases.upload" ? { ok: true, result: { tgz: "https://r2.test/a.tgz?s", sha256: "https://r2.test/a.sha256?s" } } : undefined));
    const puts: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((u: RequestInfo | URL, init?: RequestInit) => {
      puts.push(String(u));
      return new Promise((_ok, no) => init?.signal?.addEventListener("abort", () => no(new Error("aborted"))));
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = call("upload", { part: "capture", version: "1.4.2", dir: "." }, dir);
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
