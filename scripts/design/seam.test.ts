// Шов прототипа: что уходит в прод, что отвечает мок, что не отправляется. Вход — кадр модуля и подделка «настоящего» ответа,
// исход — кадры, ушедшие в связь, ответ модулю и тост. Номер — эталон дизайна «Прототип на настоящем фронте».
import { describe, expect, it } from "vitest";
import type { Frame, Reply } from "@switchboard/protocol";
import type { ProtoMock } from "./api.ts";
import { protoSeam } from "./seam.ts";

type Keys = { keys: string[] };
/** Мок образца: новое по договору — список ключей флота и добавление ключа; история сессии — безвредная запись. */
const mock: ProtoMock<Keys> = {
  owns: ["accounts.list", "accounts.add", "accounts.remove"],
  state: () => ({ keys: ["orca"] }),
  harmless: ["session.history"],
  answer(f, ctx) {
    if (f.type === "accounts.list") return { ok: true, result: { accounts: ctx.state.keys } };
    if (f.type === "accounts.add") {
      ctx.state.keys.push(String(f.name));
      return { ok: true };
    }
  },
};

function rig() {
  const wire: Frame[] = [];
  const notices: string[] = [];
  const real = async (f: Frame): Promise<Reply> => (wire.push(f), { type: "reply", id: f.id as string, ok: true, result: { prod: true } }) as Reply;
  const seam = protoSeam({ mock, state: mock.state!(), notice: (t) => void notices.push(t), data: async () => ({}) as never });
  const ask = (f: Record<string, unknown>, read = false) => seam.request({ id: `q${wire.length}`, v: 1, ...f } as Frame, read, real) as Promise<Reply & { ok: boolean; result?: any; error?: string }>;
  return { wire, notices, ask };
}

describe("шов прототипа", () => {
  it("1 · чтение — в прод, ответ прода модулю", async () => {
    const r = rig();
    expect(await r.ask({ type: "session.view", callsign: "a@pc" }, true)).toMatchObject({ ok: true, result: { prod: true } });
    expect(r.wire.map((f) => f.type)).toEqual(["session.view"]);
  });

  it("2 · запись без мока и не из безвредных — в связь 0 кадров, тост с типом запроса", async () => {
    const r = rig();
    expect(await r.ask({ type: "session.stop", callsign: "a@pc" })).toMatchObject({ ok: false, error: "prototype" });
    expect(r.wire).toEqual([]);
    expect(r.notices).toEqual([expect.stringMatching(/^прототип: не отправлено · session\.stop .*a@pc/)]);
  });

  it("безвредная запись — в прод", async () => {
    const r = rig();
    await r.ask({ type: "session.history", callsign: "a@pc" });
    expect(r.wire.map((f) => f.type)).toEqual(["session.history"]);
  });

  it("3 · новый запрос, мок отвечает — ответ мока, в связь 0 кадров", async () => {
    const r = rig();
    expect(await r.ask({ type: "accounts.list" }, true)).toMatchObject({ ok: true, result: { accounts: ["orca"] } });
    expect(r.wire).toEqual([]);
  });

  it("9 · «+ ключ», затем список ключей — в связь 0 кадров, новый ключ в списке", async () => {
    const r = rig();
    expect(await r.ask({ type: "accounts.add", name: "kimi" })).toMatchObject({ ok: true });
    expect(await r.ask({ type: "accounts.list" }, true)).toMatchObject({ result: { accounts: ["orca", "kimi"] } });
    expect(r.wire).toEqual([]);
  });

  it("10 · запрос из договора дизайна, мок его не знает — тост «мок не отвечает», в связь 0 кадров, слова offline нет", async () => {
    const r = rig();
    const a = await r.ask({ type: "accounts.remove", name: "orca" });
    expect(a).toMatchObject({ ok: false, error: "no_mock" });
    expect(JSON.stringify(a)).not.toContain("offline");
    expect(r.wire).toEqual([]);
    expect(r.notices).toEqual([expect.stringMatching(/^прототип: мок не отвечает accounts\.remove/)]);
  });

  it("настройка страницы — в памяти: prefs.set не уходит, prefs.get отдаёт её поверх прода", async () => {
    const r = rig();
    await r.ask({ type: "prefs.set", scope: "app:pult", name: "web-board.filters", value: [1] });
    const g = await r.ask({ type: "prefs.get", scope: "app:pult" }, true);
    expect(r.wire.map((f) => f.type)).toEqual(["prefs.get"]);
    expect(g.result.values).toMatchObject({ "web-board.filters": [1] });
  });
});
