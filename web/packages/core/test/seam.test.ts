// Шов ядра StartOptions.seam: каждый запрос модуля и каждый roster проходят через него до связи и до модулей.
// Вход — контракт web-core и стенд, исход — кадры в связи и то, что видит модуль. Номер — эталон дизайна «Прототип на настоящем фронте».
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, AppPart, Roster, StartOptions } from "../contract.ts";
import { stand } from "../stand/app.ts";
import { FakeRelay, oneMachine } from "../stand/relay.ts";

/** Модуль-образец: запрос answer к Host, roster — в журнал. */
function sample() {
  const box = { app: undefined as unknown as App, rosters: [] as Roster[] };
  const part: AppPart = {
    manifest: { name: "sample", type: "web", version: "1.0.0", provides: {}, uses: { "app@web-core": 2, "roster@relay": 1, "answer@host-questions": 1 } },
    module: (a) => {
      box.app = a;
      return { on: { roster: (r) => void box.rosters.push(r) } };
    },
  };
  return { part, box };
}

type Seam = NonNullable<StartOptions["seam"]>;

describe("шов ядра", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("1 · чтение через шов уходит в связь с признаком read, ответ — модулю", async () => {
    const reads: boolean[] = [];
    const seam: Seam = { request: (f, read, real) => (reads.push(read), real(f)), roster: (r) => r };
    const s = sample();
    const relay = new FakeRelay(oneMachine());
    relay.handlers.answer = () => ({ ok: true, result: { n: 1 } });
    await stand([s.part], { relay, options: { seam } });
    expect(await s.box.app.read("answer", { callsign: "profiles@laptop" })).toEqual({ ok: true, result: { n: 1 } });
    expect(await s.box.app.request("answer", { callsign: "profiles@laptop" })).toEqual({ ok: true, result: { n: 1 } });
    expect(relay.sent("answer")).toHaveLength(2);
    expect(reads).toEqual([true, false]);
  });

  it("3 · шов отвечает сам — в связь 0 кадров, модуль получает ответ шва", async () => {
    const seam: Seam = { request: async (f) => ({ type: "reply", id: f.id as string, ok: true, result: { mock: true } }) as never, roster: (r) => r };
    const s = sample();
    const relay = new FakeRelay(oneMachine());
    await stand([s.part], { relay, options: { seam } });
    expect(await s.box.app.request("answer", { callsign: "profiles@laptop" })).toEqual({ ok: true, result: { mock: true } });
    expect(relay.sent("answer")).toHaveLength(0);
  });

  it("4 · roster с прода, шов добавляет поле — модули и app.roster видят его, и на первом, и на следующем", async () => {
    const seam: Seam = { request: (f, _r, real) => real(f), roster: (r) => ({ ...r, sessions: r.sessions.map((x) => ({ ...x, pieces: ["base"] })) }) };
    const s = sample();
    const relay = new FakeRelay(oneMachine());
    await stand([s.part], { relay, options: { seam } });
    expect(s.box.rosters.at(-1)!.sessions[0]).toMatchObject({ pieces: ["base"] });
    expect(s.box.app.roster()!.sessions[0]).toMatchObject({ pieces: ["base"] });
    const r = oneMachine();
    r.sessions = [...r.sessions, { callsign: "x@laptop", state: "waiting" }];
    relay.setRoster(r);
    await new Promise((ok) => setTimeout(ok, 5));
    expect(s.box.rosters.at(-1)!.sessions.map((x) => x.pieces)).toEqual(r.sessions.map(() => ["base"]));
  });
});
