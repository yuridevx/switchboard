// Эталоны manage на стенде Host: поддельные SDK, relay, keeper и часы. Номер эталона — номер теста.
// slots и profiles — поддельные модули стенда: их пишут другие.
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Ctx, Frame, Host, Manifest, OpenSpec, QueryPart, Session, SessionState } from "@switchboard/host";
import { manage } from "../src/manage.ts";
import profilesManifest from "../../profiles/module.json" with { type: "json" };
import { make as makeProfiles } from "../../profiles/src/profiles.ts";

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "module.json"), "utf8")) as Manifest;
const stands: stand.Stand[] = [];
afterEach(async () => {
  for (const st of stands.splice(0)) await st.close();
});

type Seen = Array<[string, Record<string, unknown>]>;
/** Host laptop: manage и поддельные slots, profiles; seen — их запросы по порядку. */
async function laptop(o: { home?: string } = {}) {
  const seen: Seen = [];
  const slots = stand.module("host-slots", { requests: { "session.slot": (f) => (seen.push(["session.slot", f]), { restart: false }) } });
  const profiles = stand.module("host-profiles", { requests: { "session.profile": (f) => (seen.push(["session.profile", f]), { restart: false }) } });
  const home = o.home ?? mkdtempSync(join(tmpdir(), "switchboard-manage-"));
  const st = await stand.standHost({ modules: [slots, profiles, { manifest, module: manage({ home }) }] });
  stands.push(st);
  return { st, seen, home };
}
const req = (st: stand.Stand, f: Record<string, unknown>) => st.relay.request({ v: 1, ...f } as Frame & { type: string });

describe("эталоны manage", () => {
  it("84 · getContextUsage — ответ SDK как есть; close — unknown_method, close() не вызван, процесс жив", async () => {
    const { st } = await laptop();
    await st.open("site@laptop");
    const usage = { totalTokens: 41210, maxTokens: 200000, percentage: 21, categories: [{ name: "messages", tokens: 30000 }] };
    const q = st.query("site@laptop") as unknown as Record<string, unknown>;
    q.getContextUsage = async () => usage;
    expect(await req(st, { type: "session.call", callsign: "site@laptop", method: "getContextUsage", args: [] })).toMatchObject({ ok: true, result: usage });
    expect(await req(st, { type: "session.call", callsign: "site@laptop", method: "close" })).toMatchObject({ ok: false, error: "unknown_method" });
    expect(st.query("site@laptop").calls.map((c) => c.name)).not.toContain("close");
    expect(st.proc("site@laptop").alive).toBe(true);
    expect(st.kernel.sessions.get("site@laptop")!.state).toBe("idle");
  });

  it("85 · update посреди хода: setModel и applyFlagSettings сразу, ход не прерван; после resume query() с sonnet и medium", async () => {
    const { st } = await laptop();
    await st.open("site@laptop");
    const p = st.proc("site@laptop");
    p.send(stand.msg.state("running"));
    await stand.until(() => st.kernel.sessions.get("site@laptop")!.state === "busy");
    const r = await req(st, { type: "session.update", callsign: "site@laptop", model: "sonnet", effort: "medium" });
    expect(r).toMatchObject({ ok: true, result: { now: ["model", "effort"] } });
    const calls = st.query("site@laptop").calls;
    expect(calls).toEqual([
      { name: "setModel", args: ["sonnet"] },
      { name: "applyFlagSettings", args: [{ effortLevel: "medium" }] },
    ]);
    expect(p.interrupts).toBe(0);
    p.exit(1, "упал");
    await stand.until(() => st.sdk.of("site@laptop").length === 2 && st.kernel.sessions.get("site@laptop")!.state === "idle");
    expect(st.query("site@laptop").options).toMatchObject({ model: "sonnet", effort: "medium", resume: st.kernel.sessions.get("site@laptop")!.rec.session_id });
  });

  it("86 · stop посреди команды: interrupt, result, close(); stopped и сама не поднимается; start — resume с тем же session_id, idle", async () => {
    const { st } = await laptop();
    const s = await st.open("site@laptop");
    const sid = s.info.session_id;
    const p = st.proc("site@laptop");
    p.send(stand.msg.state("running"));
    await stand.until(() => s.state === "busy");
    expect(await req(st, { type: "session.stop", callsign: "site@laptop" })).toMatchObject({ ok: true });
    expect(p.interrupts).toBe(1);
    expect(st.query("site@laptop").calls.map((c) => c.name)).toEqual(["interrupt", "close"]);
    expect(st.states("site@laptop").at(-1)?.state).toBe("stopped");
    expect(st.sdk.of("site@laptop")).toHaveLength(1);
    expect(await req(st, { type: "session.start", callsign: "site@laptop" })).toMatchObject({ ok: true });
    expect(st.sdk.of("site@laptop")).toHaveLength(2);
    expect(st.query("site@laptop").options.resume).toBe(sid);
    expect(s.info.session_id).toBe(sid);
    expect(s.state).toBe("idle");
  });

  it("87 · open с профилем и слотом без модели: до host.open — по одному session.profile и session.slot; в разделе ни папки, ни профиля, ни слота; ledger.add session.opened by panel-desk; spec из своих мест", async () => {
    // На модели Host: ядро сейчас отвечает offline на запрос с callsign ещё не открытой сессии (см. отчёт) —
    // поэтому порядок шагов manage проверяется на своём входе, без ядра.
    const log: Array<[string, unknown]> = [];
    const stores = new Map<string, unknown>();
    let s!: Session;
    const mod = manage({ home: "/home/u" });
    const host = {
      machine: "laptop",
      session: (cs: string) => (s && s.info.callsign === cs ? s : undefined),
      request: async (name: string, p: Record<string, unknown>) => (log.push([name, p]), { ok: true, result: { restart: false } }),
      emit: (f: Frame) => (log.push(["emit", f]), { ok: true }),
      log: () => {},
      open: async (spec: OpenSpec) => {
        log.push(["host.open", spec]);
        s = {
          info: { callsign: spec.callsign, session_id: "42bc5ad4", cwd: spec.cwd, model: "claude-opus-5", sdk: "0.3.311", from: null, start: "spawn" },
          state: "idle" as SessionState,
          store: () => ({ get: () => stores.get(spec.callsign), set: (v: unknown) => void stores.set(spec.callsign, v), update: () => undefined }),
          sdk: async (name: string) => (log.push(["sdk", name]), name === "getSessionInfo" ? { customTitle: "board", summary: "x" } : undefined),
        } as unknown as Session;
        log.push(["query()", mod.session!(s)]);
        return s;
      },
    } as unknown as Host;
    const ctx: Ctx = { host, from: "panel-desk~owner@example.com", signal: new AbortController().signal };
    const dir = mkdtempSync(join(tmpdir(), "switchboard-manage-"));
    const r = await mod.requests!["session.open"]({ type: "session.open", id: "c-7", v: 1, machine: "laptop", name: "board", dir, profile: "team/profiles/ops", slot: "main" }, ctx);
    expect(r).toEqual({ callsign: "board@laptop", session_id: "42bc5ad4" });
    expect(log.map((l) => l[0])).toEqual(["session.profile", "session.slot", "host.open", "query()", "emit"]);
    expect(log[0][1]).toEqual({ callsign: "board@laptop", profile: "team/profiles/ops" });
    expect(log[1][1]).toEqual({ callsign: "board@laptop", slot: "main" });
    expect(log[2][1]).toEqual({ callsign: "board@laptop", cwd: dir });
    const part = log[3][1] as QueryPart;
    expect(part).toMatchObject({ enableFileCheckpointing: true, title: "board" });
    expect(part.model).toBeUndefined();
    expect(part.effort).toBeUndefined();
    // в разделе manage — только родитель: ни папки, ни профиля, ни слота
    expect(stores.get("board@laptop")).toEqual({ parent: "panel-desk~owner@example.com" });
    expect(log[4][1]).toMatchObject({ type: "ledger.add", to: ".ledger", ev: "session.opened", by: "panel-desk~owner@example.com", machine: "laptop", callsign: "board@laptop" });
    const spec = await mod.requests!["session.spec"]({ type: "session.spec", id: "k-6", v: 1, callsign: "board@laptop" }, ctx);
    expect(spec).toEqual({ dir, model: null, effort: null, title: "board" });
  });

  it("87 · то же на стенде без профиля и слота: ответ после initialize, query() без модели, ledger.add, spec — папка у ядра, заголовок из файла", async () => {
    const { st, home } = await laptop();
    mkdirSync(join(home, "Projects", "switchboard"), { recursive: true });
    const r = await req(st, { type: "session.open", machine: "laptop", name: "board", dir: "~/Projects/switchboard" });
    expect(r).toMatchObject({ ok: true, result: { callsign: "board@laptop" } });
    const q = st.query("board@laptop");
    expect(q.options).toMatchObject({ cwd: join(home, "Projects", "switchboard"), title: "board", enableFileCheckpointing: true });
    expect(q.options.model).toBeUndefined();
    expect(st.relay.frames("ledger.add")).toEqual([
      expect.objectContaining({ to: ".ledger", ev: "session.opened", by: "panel-desk~owner@example.com", callsign: "board@laptop", text: "board@laptop создана · ~/Projects/switchboard" }),
    ]);
    const spec = await req(st, { type: "session.spec", callsign: "board@laptop" });
    expect(spec).toMatchObject({ ok: true, result: { dir: "~/Projects/switchboard", model: null, effort: null } });
    expect(st.sdk.fnCalls.find((c) => c.name === "getSessionInfo")?.args[0]).toBe((r.result as { session_id: string }).session_id);
    // родитель — отправитель запроса (принятый дизайн: «session.open запоминает отправителя запроса… Поле roster parent»)
    await stand.until(() => st.states("board@laptop").at(-1)?.parent === "panel-desk~owner@example.com");
  });

  it("237 · заголовок остановленной docs — функция SDK renameSession; раздел manage заголовка не хранит", async () => {
    const { st } = await laptop();
    const docs = await st.open("docs@laptop");
    await docs.stop();
    expect(await req(st, { type: "session.update", callsign: "docs@laptop", title: "Документы" })).toMatchObject({ ok: true, result: { now: ["title"] } });
    expect(st.sdk.fnCalls.filter((c) => c.name === "renameSession")).toEqual([{ name: "renameSession", args: [docs.info.session_id, "Документы", { dir: docs.info.cwd }] }]);
    expect(st.session("host-manage", "docs@laptop")!.store().get()).toBeUndefined();
  });

  it("237 · заголовок живой site — метод renameSession живого query", async () => {
    const { st } = await laptop();
    await st.open("site@laptop");
    await req(st, { type: "session.update", callsign: "site@laptop", title: "Сайт" });
    expect(st.query("site@laptop").calls).toContainEqual({ name: "renameSession", args: ["Сайт", expect.any(String)] });
  });
});

describe("manage", () => {
  it("open: имя занято — name_taken; папки нет — bad_spec; усилие не того вида — bad_spec; незнакомое поле — не ошибка", async () => {
    const { st, home } = await laptop();
    await st.open("site@laptop");
    mkdirSync(join(home, "p"));
    expect(await req(st, { type: "session.open", machine: "laptop", name: "site", dir: "~/p" })).toMatchObject({ ok: false, error: "name_taken" });
    expect(await req(st, { type: "session.open", machine: "laptop", name: "x", dir: "~/нет" })).toMatchObject({ ok: false, error: "bad_spec" });
    // папка не от ~ и не полная — отказ, а не путь от папки выпуска Host (одно правило ядра clientPath)
    expect(await req(st, { type: "session.open", machine: "laptop", name: "x", dir: "p" })).toMatchObject({ ok: false, error: "bad_spec" });
    expect(await req(st, { type: "session.open", machine: "laptop", name: "x", dir: "~/p", effort: "ultra" })).toMatchObject({ ok: false, error: "bad_spec" });
    expect(st.journal().find((l) => l.word === "bad_spec" && String(l.why).includes("effort"))).toBeTruthy();
    expect(await req(st, { type: "session.open", machine: "laptop", name: "x", dir: "~/p", color: "red", model: "opus", fast: true })).toMatchObject({ ok: true });
    expect(st.query("x@laptop").options).toMatchObject({ model: "opus", settings: { fastMode: true } });
    expect(st.session("host-manage", "x@laptop")!.store().get()).toEqual({ model: "opus", fast: true, parent: "panel-desk~owner@example.com" });
  });

  it("3118 · open с папкой полным путём — как есть (так её шлёт подъём точки)", async () => {
    // источник: чьё: код (правило clientPath ядра: полный путь — как есть; подъём точки открывает сессию с полным путём)
    const { st, home } = await laptop();
    const full = join(home, "full");
    mkdirSync(full);
    expect(await req(st, { type: "session.open", machine: "laptop", name: "y", dir: full })).toMatchObject({ ok: true });
    expect(st.query("y@laptop").options.cwd).toBe(full);
  });

  it("open: процесс вышел до initialize — open_failed, повтора нет", async () => {
    const { st, home } = await laptop();
    mkdirSync(join(home, "p"));
    st.holders.failInitNext = 1;
    const pr = req(st, { type: "session.open", machine: "laptop", name: "x", dir: "~/p" });
    await stand.until(() => st.holders.procs.get("x@laptop"));
    st.proc("x@laptop").exit(1, "нет входа");
    expect(await pr).toMatchObject({ ok: false, error: "open_failed" });
    expect(st.journal().some((l) => l.ev === "request" && l.word === "open_failed" && String(l.why).includes("x@laptop"))).toBe(true);
    // запись сессии остаётся у ядра (её ведёт ветка устава «один resume, второй сбой — failed»); журнал флота не пишется
    expect(st.kernel.sessions.has("x@laptop")).toBe(true);
    expect(st.relay.frames("ledger.add").filter((f) => f.ev === "session.opened")).toHaveLength(0);
    expect(await req(st, { type: "session.open", machine: "laptop", name: "x", dir: "~/p" })).toMatchObject({ ok: false, error: "name_taken" });
  });

  it("call: interrupt — ответ SDK; остановленной — stopped; ошибка SDK — sdk_error, модуль работает", async () => {
    const { st } = await laptop();
    await st.open("site@laptop");
    const q = st.query("site@laptop") as unknown as Record<string, unknown>;
    q.interrupt = async () => ({ still_queued: [] });
    expect(await req(st, { type: "session.call", callsign: "site@laptop", method: "interrupt" })).toMatchObject({ ok: true, result: { still_queued: [] } });
    q.toggleMcpServer = async () => {
      throw new Error("нет сервера github");
    };
    expect(await req(st, { type: "session.call", callsign: "site@laptop", method: "toggleMcpServer", args: ["github", false] })).toMatchObject({ ok: false, error: "sdk_error" });
    expect(await req(st, { type: "session.call", callsign: "site@laptop", method: "supportedModels" })).toMatchObject({ ok: true });
    expect(await req(st, { type: "session.call", callsign: "site@laptop", method: "interrupt", args: "x" })).toMatchObject({ ok: false, error: "bad_spec" });
    await st.kernel.sessions.get("site@laptop")!.stop();
    expect(await req(st, { type: "session.call", callsign: "site@laptop", method: "supportedModels" })).toMatchObject({ ok: false, error: "stopped" });
  });

  it("update остановленной: спецификация записана, методов нет; start — query() с новой моделью и флагами", async () => {
    const { st } = await laptop();
    const s = await st.open("site@laptop");
    await s.stop();
    expect(await req(st, { type: "session.update", callsign: "site@laptop", model: "haiku", style: "Explanatory", thinking: false })).toMatchObject({ ok: true, result: { now: [] } });
    await s.start();
    expect(st.query("site@laptop").options).toMatchObject({ model: "haiku", settings: { outputStyle: "Explanatory", alwaysThinkingEnabled: false } });
    expect(st.query("site@laptop").options.title).toBeUndefined(); // заголовок — только при первом старте
  });

  it("PostModelSwitch: модель сменили в claude.ai — спецификация и поле model берут новую; source resume — не трогает", async () => {
    const { st } = await laptop();
    const s = await st.open("site@laptop");
    const p = st.proc("site@laptop");
    await p.hook("PostModelSwitch", { from_model: "a", to_model: "claude-opus-5", requested_model: "opus", source: "command" });
    expect(st.session("host-manage", "site@laptop")!.store().get()).toEqual({ model: "opus" });
    await p.hook("PostModelSwitch", { requested_model: "sonnet", source: "resume" });
    expect(st.session("host-manage", "site@laptop")!.store().get()).toEqual({ model: "opus" });
    s.input("x");
    stand.turn(p);
    await stand.until(() => st.states("site@laptop").at(-1)?.model === "opus");
  });

  it("remove: stop, запись убрана, раздел стёрт; ledger.add session.removed", async () => {
    const { st } = await laptop();
    await st.open("wiki@laptop");
    await req(st, { type: "session.update", callsign: "wiki@laptop", model: "opus" });
    expect(await req(st, { type: "session.remove", callsign: "wiki@laptop" })).toMatchObject({ ok: true });
    expect(st.kernel.sessions.has("wiki@laptop")).toBe(false);
    expect(st.relay.frames("ledger.add").at(-1)).toMatchObject({ ev: "session.removed", callsign: "wiki@laptop", by: "panel-desk~owner@example.com" });
    expect(await req(st, { type: "session.spec", callsign: "wiki@laptop" })).toMatchObject({ ok: false, error: "offline" });
  });

  it("open с number: к имени первый свободный номер — disk-full-1, затем disk-full-2; два сразу — разные; убранный номер снова свободен", async () => {
    const { st, home } = await laptop();
    const dir = join(home, "ops");
    mkdirSync(dir);
    const open = () => req(st, { type: "session.open", machine: "laptop", name: "disk-full", number: true, dir });
    expect(await open()).toMatchObject({ ok: true, result: { callsign: "disk-full-1@laptop" } });
    expect(await open()).toMatchObject({ ok: true, result: { callsign: "disk-full-2@laptop" } });
    const both = await Promise.all([open(), open()]);
    expect(both.map((r) => (r.result as { callsign: string }).callsign).sort()).toEqual(["disk-full-3@laptop", "disk-full-4@laptop"]);
    await req(st, { type: "session.remove", callsign: "disk-full-1@laptop" });
    expect(await open()).toMatchObject({ ok: true, result: { callsign: "disk-full-1@laptop" } });
    expect(st.query("disk-full-2@laptop").options.title).toBe("disk-full-2");
  });

  it("remove с after_turn посреди хода: ход не прерван, сессия убрана после его конца; ledger — от того, кто просил; простаивающая — сразу", async () => {
    const { st } = await laptop();
    const s = await st.open("wiki@laptop");
    const p = st.proc("wiki@laptop");
    p.send(stand.msg.state("running"));
    await stand.until(() => s.state === "busy");
    expect(await req(st, { type: "session.remove", callsign: "wiki@laptop", after_turn: true, from: "lead@laptop" })).toMatchObject({ ok: true, result: { after_turn: true } });
    expect(p.interrupts).toBe(0);
    expect(st.kernel.sessions.has("wiki@laptop")).toBe(true);
    p.send(stand.msg.result());
    p.send(stand.msg.state("idle"));
    await stand.until(() => !st.kernel.sessions.has("wiki@laptop"));
    expect(p.interrupts).toBe(0);
    expect(st.relay.frames("ledger.add").at(-1)).toMatchObject({ ev: "session.removed", callsign: "wiki@laptop", by: "lead@laptop" });
    await st.open("docs@laptop");
    expect(await req(st, { type: "session.remove", callsign: "docs@laptop", after_turn: true })).toMatchObject({ ok: true });
    expect(st.kernel.sessions.has("docs@laptop")).toBe(false);
  });
});

describe("эталоны manage: ядро управления сессиями", () => {
  it("320 · open: профиля нет — no_profile, причина в журнале, сессии нет; тот же запрос без профиля — имя свободно", async () => {
    // источник: принятый дизайн, ожидаемые ветки — «Нет папки или профиля типа — … no_profile, причина в журнале; сессии нет»; имя свободно — чьё: код
    const saved = process.env.SWITCHBOARD_HOME;
    process.env.SWITCHBOARD_HOME = mkdtempSync(join(tmpdir(), "switchboard-manage-sb-"));
    try {
      const home = mkdtempSync(join(tmpdir(), "switchboard-manage-"));
      const slots = stand.module("host-slots", { requests: { "session.slot": () => ({ restart: false }) } });
      const st = await stand.standHost({ modules: [slots, { manifest: profilesManifest as Manifest, module: makeProfiles({ git: async () => ({ code: 0, out: "" }) }) }, { manifest, module: manage({ home }) }] });
      stands.push(st);
      expect(await req(st, { type: "session.open", machine: "laptop", name: "board", dir: "~", profile: "you/profiles/missing" })).toMatchObject({ ok: false, error: "no_profile" });
      expect(st.journal().some((l) => l.ev === "request" && l.word === "no_profile" && String(l.why).includes("board@laptop"))).toBe(true);
      expect(st.kernel.sessions.has("board@laptop")).toBe(false);
      expect(await req(st, { type: "session.open", machine: "laptop", name: "board", dir: "~" })).toMatchObject({ ok: true, result: { callsign: "board@laptop" } });
    } finally {
      if (saved === undefined) delete process.env.SWITCHBOARD_HOME;
      else process.env.SWITCHBOARD_HOME = saved;
    }
  });

  it("321 · журнал флота не отвечает: open и remove модуля этой машины — исполнены, заметка ledger.add offline в журнале Host", async () => {
    // источник: устав — прямой запрос к Worker'у не прошёл — отказ словом; заметка без очереди — чьё: код (клиент флота onLost)
    const home = mkdtempSync(join(tmpdir(), "switchboard-manage-"));
    const caller = stand.module("host-caller", {}, { uses: { "session.open@host-manage": 1, "session.remove@host-manage": 1 } });
    const slots = stand.module("host-slots", { requests: { "session.slot": () => ({ restart: false }) } });
    const profiles = stand.module("host-profiles", { requests: { "session.profile": () => ({ restart: false }) } });
    const st = await stand.standHost({ modules: [slots, profiles, { manifest, module: manage({ home }) }, caller] });
    stands.push(st);
    st.relay.workersDown = true;
    const h = st.host("host-caller");
    expect(await h.request("session.open", { v: 1, machine: "laptop", name: "board", dir: "~" })).toMatchObject({ ok: true, result: { callsign: "board@laptop" } });
    expect(await h.request("session.remove", { v: 1, callsign: "board@laptop" })).toEqual({ ok: true, result: undefined });
    expect(st.kernel.sessions.has("board@laptop")).toBe(false);
    const notes = await stand.until(() => {
      const n = st.journal().filter((l) => l.ev === "ledger.add" && l.word === "offline");
      return n.length === 2 && n;
    });
    expect(notes.map((l) => String(l.why).split(" ")[0])).toEqual(["ledger.add", "ledger.add"]);
  });

  it("322 · remove after_turn посреди хода, Host перезапущен, ход кончился у держателя — новый Host убирает сессию после хода; session.removed в журнале флота", async () => {
    // источник: устав — после перезапуска Host модуль поднимает своё из хранилища; принятый дизайн — «убрать после конца идущего хода»
    const k = new stand.FakeHolders();
    const work = mkdtempSync(join(tmpdir(), "switchboard-manage-"));
    const host = (home?: string) =>
      stand.standHost({
        home,
        holders: k,
        modules: [stand.module("host-slots", { requests: { "session.slot": () => ({ restart: false }) } }), stand.module("host-profiles", { requests: { "session.profile": () => ({ restart: false }) } }), { manifest, module: manage({ home: work }) }],
      });
    try {
      const a = await host();
      const s = await a.open("wiki@laptop");
      const p = k.procs.get("wiki@laptop")!;
      p.send(stand.msg.state("running"));
      await stand.until(() => s.state === "busy");
      expect(await req(a, { type: "session.remove", callsign: "wiki@laptop", after_turn: true })).toMatchObject({ ok: true, result: { after_turn: true } });
      await a.close();
      await stand.until(() => p.sock === null);
      p.send(stand.msg.result({ result: "готово" }));
      p.send(stand.msg.state("idle"));
      const b = await host(a.home);
      stands.push(b);
      await stand.until(() => !b.kernel.sessions.has("wiki@laptop"));
      expect(p.interrupts).toBe(0);
      expect(b.relay.frames("ledger.add").at(-1)).toMatchObject({ ev: "session.removed", callsign: "wiki@laptop", by: "panel-desk~owner@example.com" });
    } finally {
      for (const st of stands.splice(0)) await st.close();
      await k.close();
    }
  });

  it("323 · вход отклонён: remove с after_turn не true — bad_spec, сессия на месте", async () => {
    // источник: устав — ошибки словами; слово bad_spec — чьё: код (контракт manage)
    const { st } = await laptop();
    await st.open("wiki@laptop");
    expect(await req(st, { type: "session.remove", callsign: "wiki@laptop", after_turn: "yes" })).toMatchObject({ ok: false, error: "bad_spec" });
    expect(st.kernel.sessions.has("wiki@laptop")).toBe(true);
  });

  it("324 · вход отклонён: update с усилием не того вида — bad_spec, причина в журнале; SDK не вызван, в roster усилия нет", async () => {
    // источник: устав — ошибки словами; слово bad_spec — чьё: код (контракт manage)
    const { st } = await laptop();
    await st.open("docs@laptop");
    expect(await req(st, { type: "session.update", callsign: "docs@laptop", effort: "turbo" })).toMatchObject({ ok: false, error: "bad_spec" });
    expect(st.journal().some((l) => l.word === "bad_spec" && String(l.why).includes("effort"))).toBe(true);
    expect(st.query("docs@laptop").calls).toEqual([]);
    expect(st.states("docs@laptop").at(-1)!.effort).toBeUndefined();
  });

  it("325 · update: SDK отказал setModel — sdk_error, причина в журнале; manage не выключен", async () => {
    // источник: устав — ошибки словами; «отказ SDK — слово sdk_error, причина в журнале; модуль не выключается» — чьё: код
    const { st } = await laptop();
    await st.open("docs@laptop");
    (st.query("docs@laptop") as unknown as Record<string, unknown>).setModel = async () => {
      throw new Error("модели нет");
    };
    expect(await req(st, { type: "session.update", callsign: "docs@laptop", model: "sonnet" })).toMatchObject({ ok: false, error: "sdk_error" });
    expect(st.journal().some((l) => l.word === "sdk_error" && String(l.why).includes("модели нет"))).toBe(true);
    expect(st.states("docs@laptop").every((f) => !f.failed)).toBe(true);
    expect(st.journal().some((l) => l.ev === "module_failed")).toBe(false);
  });
});

describe("manage: покрытие плана host-modules", () => {
  it("3028 · open с resume — session_id прежний, старт resume; с fork — новый разговор от прежнего", async () => {
    // источник: чьё: код (manage.ts:179-185; host/core/contract.ts OpenSpec)
    const { st } = await laptop();
    const sid = "11111111-2222-4333-8444-555555555555";
    const r = await req(st, { type: "session.open", machine: "laptop", name: "r", dir: "~", resume: sid });
    expect(r).toMatchObject({ ok: true, result: { callsign: "r@laptop", session_id: sid } });
    expect(st.session("host-manage", "r@laptop")!.info.start).toBe("resume");
    expect(st.query("r@laptop").options.resume).toBe(sid);
    const f = await req(st, { type: "session.open", machine: "laptop", name: "f", dir: "~", resume: sid, fork: true });
    expect(f).toMatchObject({ ok: true, result: { callsign: "f@laptop" } });
    expect((f.result as { session_id: string }).session_id).not.toBe(sid);
    expect(st.query("f@laptop").options).toMatchObject({ resume: sid, forkSession: true });
  });

  it("3030 · session.spec: SDK отказал — sdk_error, manage жив", async () => {
    // источник: чьё: код (manage.ts:78-85)
    const { st } = await laptop();
    await st.open("site@laptop");
    st.sdk.functions = { getSessionInfo: async () => { throw new Error("файла нет"); } };
    expect(await req(st, { type: "session.spec", callsign: "site@laptop" })).toMatchObject({ ok: false, error: "sdk_error" });
    expect(st.journal().some((l) => l.ev === "module_failed")).toBe(false);
  });

  it("3031 · session.start поднимает сессию failed", async () => {
    // источник: слово пользователя (устав: «второй сбой до готовности — failed», дальше решает агент)
    const { st } = await laptop();
    const s = await st.open("site@laptop");
    st.holders.failInitNext = 1;
    st.proc("site@laptop").exit(1, "первый");
    await stand.until(() => st.sdk.of("site@laptop").length === 2 && st.holders.procs.get("site@laptop")?.initializes === 1);
    st.proc("site@laptop").exit(1, "второй");
    await stand.until(() => s.state === "failed");
    expect(await req(st, { type: "session.start", callsign: "site@laptop" })).toMatchObject({ ok: true });
    expect(s.state).toBe("idle");
  });

  it("3032 · session.start: не поднялась — open_failed; point не число — bad_spec", async () => {
    // источник: чьё: код (manage/contract.ts:11; manage.ts:247, :250-252)
    const { st } = await laptop();
    const s = await st.open("site@laptop");
    await s.stop();
    expect(await req(st, { type: "session.start", callsign: "site@laptop", point: "3" })).toMatchObject({ ok: false, error: "bad_spec" });
    st.holders.failInitNext = 1;
    const pr = req(st, { type: "session.start", callsign: "site@laptop" });
    await stand.until(() => st.sdk.of("site@laptop").length === 2);
    st.proc("site@laptop").exit(1, "нет входа");
    expect(await pr).toMatchObject({ ok: false, error: "open_failed" });
  });

  it("3033 · session.start из точки — старт point с номером", async () => {
    // источник: чьё: код (manage.ts:249; host/core/contract.ts SessionInfo.point)
    const seen: Array<[string, number | undefined]> = [];
    const spy = stand.module("host-spy", { on: { open: (s) => void seen.push([s.info.start, s.info.point]) } });
    const home = mkdtempSync(join(tmpdir(), "switchboard-manage-"));
    const st = await stand.standHost({ modules: [stand.module("host-slots", { requests: { "session.slot": () => ({ restart: false }) } }), stand.module("host-profiles", { requests: { "session.profile": () => ({ restart: false }) } }), { manifest, module: manage({ home }) }, spy] });
    stands.push(st);
    const s = await st.open("site@laptop");
    await s.stop();
    expect(await req(st, { type: "session.start", callsign: "site@laptop", point: 3 })).toMatchObject({ ok: true });
    expect(seen.at(-1)).toEqual(["point", 3]);
  });

  it("3034 · выбор клиента в query(): модель, усилие, флаги, контрольные точки, хук; заголовок — только в первом", async () => {
    // источник: чьё: код (manage.ts:113-131, :56-60)
    const { st, home } = await laptop();
    mkdirSync(join(home, "p"));
    expect(await req(st, { type: "session.open", machine: "laptop", name: "site", dir: "~/p", model: "m", effort: "high", fast: true, style: "s", thinking: true })).toMatchObject({ ok: true });
    const first = st.query("site@laptop").options as Record<string, any>;
    expect(first).toMatchObject({ model: "m", effort: "high", enableFileCheckpointing: true, title: "site", settings: { fastMode: true, outputStyle: "s", alwaysThinkingEnabled: true } });
    expect(first.settings.effortLevel).toBeUndefined();
    expect(first.hooks?.PostModelSwitch).toBeDefined();
    const s = st.session("host-manage", "site@laptop")!;
    await s.stop();
    await s.start();
    const again = st.query("site@laptop").options as Record<string, any>;
    expect(again).toMatchObject({ model: "m", effort: "high", enableFileCheckpointing: true });
    expect(again.title).toBeUndefined();
  });

  it("3035 · PostModelSwitch без requested_model — выбор модели снят, следующий старт без model", async () => {
    // источник: чьё: код (manage.ts:105-107)
    const { st } = await laptop();
    const s = await st.open("site@laptop");
    s.store().set({ model: "opus" });
    await st.proc("site@laptop").hook("PostModelSwitch", { requested_model: null, source: "command" });
    await s.stop();
    await s.start();
    expect(st.query("site@laptop").options.model).toBeUndefined();
  });
});
