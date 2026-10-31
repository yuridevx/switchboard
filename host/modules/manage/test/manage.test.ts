// Эталоны manage на стенде Host: поддельные SDK, relay, keeper и часы. Номер эталона — номер теста.
// slots и profiles — поддельные модули стенда: их пишут другие.
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Ctx, Frame, Host, Manifest, OpenSpec, QueryPart, Session, SessionState } from "@switchboard/host";
import { manage } from "../src/manage.ts";

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
    const ctx: Ctx = { host, from: "panel-desk", signal: new AbortController().signal };
    const dir = mkdtempSync(join(tmpdir(), "switchboard-manage-"));
    const r = await mod.requests!["session.open"]({ type: "session.open", id: "c-7", v: 1, machine: "laptop", name: "board", dir, profile: "team/profiles/ops", slot: "main" }, ctx);
    expect(r).toEqual({ callsign: "board@laptop", session_id: "42bc5ad4" });
    expect(log.map((l) => l[0])).toEqual(["session.profile", "session.slot", "host.open", "query()", "emit"]);
    expect(log[0][1]).toEqual({ v: 1, callsign: "board@laptop", profile: "team/profiles/ops" });
    expect(log[1][1]).toEqual({ v: 1, callsign: "board@laptop", slot: "main" });
    expect(log[2][1]).toEqual({ callsign: "board@laptop", cwd: dir });
    const part = log[3][1] as QueryPart;
    expect(part).toMatchObject({ enableFileCheckpointing: true, title: "board" });
    expect(part.model).toBeUndefined();
    expect(part.effort).toBeUndefined();
    expect(stores.get("board@laptop")).toBeUndefined(); // в разделе manage нет ни папки, ни профиля, ни слота
    expect(log[4][1]).toMatchObject({ type: "ledger.add", to: "ledger", ev: "session.opened", by: "panel-desk", machine: "laptop", callsign: "board@laptop" });
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
      expect.objectContaining({ to: "ledger", ev: "session.opened", by: "panel-desk", callsign: "board@laptop", text: "board@laptop создана · ~/Projects/switchboard" }),
    ]);
    const spec = await req(st, { type: "session.spec", callsign: "board@laptop" });
    expect(spec).toMatchObject({ ok: true, result: { dir: "~/Projects/switchboard", model: null, effort: null } });
    expect(st.sdk.fnCalls.find((c) => c.name === "getSessionInfo")?.args[0]).toBe((r.result as { session_id: string }).session_id);
  });

  it("237 · заголовок остановленной docs — функция SDK renameSession; раздел manage заголовка не хранит", async () => {
    const { st } = await laptop();
    const docs = await st.open("docs@laptop");
    await docs.stop();
    expect(await req(st, { type: "session.update", callsign: "docs@laptop", title: "Документы" })).toMatchObject({ ok: true, result: { now: ["title"] } });
    expect(st.sdk.fnCalls.filter((c) => c.name === "renameSession")).toEqual([{ name: "renameSession", args: [docs.info.session_id, "Документы", { dir: docs.info.cwd }] }]);
    expect(st.session("host-manage", "docs@laptop")!.store().get()).toBeUndefined();
  });

  it.fails("237 · заголовок живой site — метод renameSession живого query (ждёт правки ядра: s.sdk зовёт функцию SDK и у живой)", async () => {
    const { st } = await laptop();
    await st.open("site@laptop");
    await req(st, { type: "session.update", callsign: "site@laptop", title: "Сайт" });
    expect(st.query("site@laptop").calls).toContainEqual({ name: "renameSession", args: ["Сайт"] });
  });
});

describe("manage", () => {
  it("open: имя занято — name_taken; папки нет — bad_spec; усилие не того вида — bad_spec; незнакомое поле — не ошибка", async () => {
    const { st, home } = await laptop();
    await st.open("site@laptop");
    mkdirSync(join(home, "p"));
    expect(await req(st, { type: "session.open", machine: "laptop", name: "site", dir: "~/p" })).toMatchObject({ ok: false, error: "name_taken" });
    expect(await req(st, { type: "session.open", machine: "laptop", name: "x", dir: "~/нет" })).toMatchObject({ ok: false, error: "bad_spec" });
    expect(await req(st, { type: "session.open", machine: "laptop", name: "x", dir: "~/p", effort: "ultra" })).toMatchObject({ ok: false, error: "bad_spec" });
    expect(st.journal().find((l) => l.word === "bad_spec" && String(l.why).includes("effort"))).toBeTruthy();
    expect(await req(st, { type: "session.open", machine: "laptop", name: "x", dir: "~/p", color: "red", model: "opus", fast: true })).toMatchObject({ ok: true });
    expect(st.query("x@laptop").options).toMatchObject({ model: "opus", settings: { fastMode: true } });
    expect(st.session("host-manage", "x@laptop")!.store().get()).toEqual({ model: "opus", fast: true });
  });

  it("open: процесс вышел до initialize — open_failed, повтора нет", async () => {
    const { st, home } = await laptop();
    mkdirSync(join(home, "p"));
    st.keeper.failInitNext = 1;
    const pr = req(st, { type: "session.open", machine: "laptop", name: "x", dir: "~/p" });
    await stand.until(() => st.keeper.procs.get("x@laptop"));
    st.proc("x@laptop").exit(1, "нет входа");
    expect(await pr).toMatchObject({ ok: false, error: "open_failed" });
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
    expect(st.relay.frames("ledger.add").at(-1)).toMatchObject({ ev: "session.removed", callsign: "wiki@laptop", by: "panel-desk" });
    expect(await req(st, { type: "session.spec", callsign: "wiki@laptop" })).toMatchObject({ ok: false, error: "offline" });
  });
});
