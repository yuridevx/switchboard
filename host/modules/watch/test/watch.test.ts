// Эталоны и стыки модуля watch на стенде Host: поддельные SDK, relay, keeper и часы.
// Окно пачки — поддельные таймеры vitest; кадры процесса идут по настоящему TCP поддельного keeper.
import { afterEach, describe, expect, it, vi } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest, Module } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { make, WINDOW_MS } from "../src/watch.ts";

const { FakeKeeper, module, msg, standHost, turn, until } = stand;
type Stand = stand.Stand;

const stands: Stand[] = [];
const keepers: stand.FakeKeeper[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const s of stands.splice(0)) await s.close();
  for (const k of keepers.splice(0)) await k.close();
});

/** Счётчик сообщений SDK: тест ждёт, пока они дошли до модулей. */
function spy() {
  const seen: string[] = [];
  const mod: Module = { on: { event: (_s, m) => void seen.push(m.type) } };
  return { seen, entry: module("host-spy", mod) };
}

async function bench(o: Parameters<typeof standHost>[0] = {}) {
  const sp = spy();
  const st = await standHost({ ...o, modules: [{ manifest: manifest as Manifest, module: make() }, sp.entry, ...(o.modules ?? [])] });
  stands.push(st);
  return { st, seen: sp.seen };
}

const events = (st: Stand) => st.relay.frames("session.events");
const watch = (st: Stand, type: string, from: string, callsign = "site@laptop") => st.relay.request({ type, v: 1, callsign, from });

describe("эталоны watch", () => {
  it("14 · panel-desk смотрит ход: пачки раз в 100 мс по порядку; до watch и после unwatch — ни кадра", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { st, seen } = await bench();
    await st.open("site@laptop");
    const p = st.proc("site@laptop");
    // до watch — ход без зрителей
    turn(p, "до");
    await until(() => seen.length === 4);
    vi.advanceTimersByTime(WINDOW_MS * 5);
    expect(events(st)).toHaveLength(0);

    expect(await watch(st, "session.watch", "panel-desk")).toMatchObject({ ok: true });
    turn(p, "раз");
    await until(() => seen.length === 8);
    vi.advanceTimersByTime(WINDOW_MS - 1);
    expect(events(st)).toHaveLength(0); // окно ещё открыто
    vi.advanceTimersByTime(1);
    expect(events(st)).toHaveLength(1);
    p.send(msg.state("running"));
    await until(() => seen.length === 9);
    p.send(msg.assistant("два"));
    await until(() => seen.length === 10);
    vi.advanceTimersByTime(WINDOW_MS);
    p.send(msg.result());
    await until(() => seen.length === 11);
    vi.advanceTimersByTime(WINDOW_MS);
    const fr = events(st);
    expect(fr.map((f) => f.seq)).toEqual([1, 2, 3]);
    for (const f of fr) expect(f).toMatchObject({ type: "session.events", v: 1, from: "site@laptop", to: ["panel-desk"] });
    expect(fr.map((f) => (f.events as Array<{ type: string }>).map((e) => e.type))).toEqual([
      ["system", "assistant", "result", "system"],
      ["system", "assistant"],
      ["result"],
    ]);

    expect(await watch(st, "session.unwatch", "panel-desk")).toMatchObject({ ok: true });
    turn(p, "после");
    await until(() => seen.length === 15);
    vi.advanceTimersByTime(WINDOW_MS * 5);
    expect(events(st)).toHaveLength(3);
  });

  it("80 · roster без panel-desk: пачки только phone, panel-desk убран из хранилища; ушёл и phone — кадров нет, пачка пропала", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { st, seen } = await bench();
    const s = await st.open("site@laptop");
    await watch(st, "session.watch", "panel-desk");
    await watch(st, "session.watch", "phone");
    const store = () => st.session("host-watch", "site@laptop")!.store<string[]>().get();
    expect(store()).toEqual(["panel-desk", "phone"]);
    st.relay.deliver({ type: "roster", machines: [], sessions: [], clients: ["phone"], workers: [] });
    await until(() => store()?.length === 1);
    expect(store()).toEqual(["phone"]);
    const p = st.proc("site@laptop");
    turn(p);
    await until(() => seen.length === 4);
    vi.advanceTimersByTime(WINDOW_MS);
    expect(events(st).map((f) => f.to)).toEqual([["phone"]]);
    // открытая пачка, потом уходит phone
    p.send(msg.state("running"));
    await until(() => seen.length === 5);
    st.relay.deliver({ type: "roster", machines: [], sessions: [], clients: [], workers: [] });
    await until(() => store()?.length === 0);
    vi.advanceTimersByTime(WINDOW_MS * 3);
    expect(events(st)).toHaveLength(1);
    expect(s.state).toBe("busy");
  });

  it("81 · Host убит посреди хода, новый сделал attach: кадры panel-desk без нового watch, seq снова с 1", async () => {
    const k = await new FakeKeeper().listen();
    keepers.push(k);
    const a = await bench({ keeper: k });
    await a.st.open("site@laptop");
    await watch(a.st, "session.watch", "panel-desk");
    const p = a.st.proc("site@laptop");
    p.send(msg.state("running"));
    p.send(msg.assistant("шаг 1"));
    await until(() => events(a.st).length === 1);
    a.st.crash();
    await until(() => p.sock === null);
    // ход идёт без Host: вывод копится у keeper
    p.send(msg.assistant("шаг 2"));
    p.send(msg.result());
    p.send(msg.state("idle"));
    const b = await bench({ keeper: k, home: a.st.home });
    await until(() => b.seen.includes("result"));
    const fr = await until(() => events(b.st)[0]);
    expect(fr).toMatchObject({ to: ["panel-desk"], seq: 1, from: "site@laptop" });
    const got = events(b.st).flatMap((f) => (f.events as Array<{ type: string }>).map((e) => e.type));
    expect(got).toEqual(["assistant", "result", "system"]);
    expect(b.st.relay.frames("session.watch")).toHaveLength(0);
  });

  it("110 · session.watchers: после unwatch phone — [panel-desk]; после roster без panel-desk — [] (не ошибка)", async () => {
    const asked: unknown[] = [];
    const q = module("host-questions", {}, { uses: { "session.watchers@host-watch": 1 } });
    const { st } = await bench({ modules: [q] });
    await st.open("site@laptop");
    await watch(st, "session.watch", "panel-desk");
    await watch(st, "session.watch", "phone");
    await watch(st, "session.unwatch", "phone");
    const h = st.host("host-questions");
    asked.push(await h.request("session.watchers", { v: 1, callsign: "site@laptop" }));
    st.relay.deliver({ type: "roster", machines: [], sessions: [], clients: ["phone"], workers: [] });
    await until(() => st.session("host-watch", "site@laptop")!.store<string[]>().get()?.length === 0);
    asked.push(await h.request("session.watchers", { v: 1, callsign: "site@laptop" }));
    expect(asked).toEqual([
      { ok: true, result: ["panel-desk"] },
      { ok: true, result: [] },
    ]);
  });
});

describe("watch: стыки", () => {
  it("includePartialMessages: true — вклад в query() каждой сессии", async () => {
    const { st } = await bench();
    await st.open("site@laptop");
    expect(st.query("site@laptop").options).toMatchObject({ includePartialMessages: true });
  });

  it("повтор watch от того же зрителя ничего не меняет; сессии нет — offline от ядра", async () => {
    const { st } = await bench();
    await st.open("site@laptop");
    await watch(st, "session.watch", "phone");
    await watch(st, "session.watch", "phone");
    expect(st.session("host-watch", "site@laptop")!.store<string[]>().get()).toEqual(["phone"]);
    expect(await watch(st, "session.watch", "phone", "wiki@laptop")).toMatchObject({ ok: false, error: "offline" });
  });

  it("штатная остановка досылает открытую пачку", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { st, seen } = await bench();
    await st.open("site@laptop");
    await watch(st, "session.watch", "panel-desk");
    st.proc("site@laptop").send(msg.state("running"));
    await until(() => seen.length === 1);
    await st.close();
    stands.splice(stands.indexOf(st), 1);
    expect(events(st)).toHaveLength(1);
    expect((events(st)[0] as Frame).events).toHaveLength(1);
  });
});
