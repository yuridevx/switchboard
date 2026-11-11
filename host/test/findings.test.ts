// Регрессии находок цикла тестов v2 (fixes.md): отмена чужого сообщения, вложение до записи, пределы шагов SDK и обхода файлов на часах ядра.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { make as chat } from "../src/modules/chat/chat.ts";
import { stand, until, type Stand } from "../stand/index.ts";

let st: Stand | undefined;
afterEach(async () => {
  await st?.stop();
  st = undefined;
});

const CS = "site@laptop";
const PULT = "pult~yuri@example.com", PHONE = "phone~yuri@example.com", ANYA = "pult~anya@example.com";
const row = (cs: string) => st!.link.rows(cs).at(-1)!.row as any;

describe("находки: разговор", () => {
  // договор: «отменить своё сообщение»
  it("сообщение в очереди отменяет его автор — с любого своего устройства; чужое — отказ not_owner, сообщение остаётся", async () => {
    st = await stand({ modules: [chat()] });
    const { proc, s } = await st.open("site");
    proc.send({ type: "system", subtype: "session_state_changed", state: "running" });
    await until(() => s.state === "busy", 5000, "ход");
    const uuid = ((await st.request("message", { to: CS, text: "ещё одно", priority: "later" }, PULT)).result as any).uuid as string;
    expect(await st.request("message.cancel", { to: CS, uuid }, ANYA)).toMatchObject({ ok: false, error: "not_owner" });
    expect(st.sdk.last(CS)!.calls.some((c) => c.name === "cancelAsyncMessage")).toBe(false);
    expect((await st.request("message.cancel", { to: CS, uuid }, PHONE)).result).toEqual({ cancelled: true });
  });

  // отказ говорит «во ввод ничего не ушло» — и строка сессии не меняется
  it("негодное вложение: отказ bad_attachment до первой записи — человек не записан в участники", async () => {
    st = await stand({ modules: [chat()] });
    const { proc } = await st.open("site");
    const before = JSON.stringify(row(CS).people ?? []);
    expect(await st.request("message", { to: CS, text: "вот", files: [{ name: "a.zip", mime: "application/zip", base64: "AA==" }] }, ANYA)).toMatchObject({ ok: false, error: "bad_attachment" });
    expect(JSON.stringify(row(CS).people ?? [])).toBe(before);
    expect(proc.inputs).toHaveLength(0);
  });

  // слово пользователя 2 нояб.: «у всех операций должен быть лимит»
  it("обход папки не уложился в предел по часам ядра — отказ timeout", async () => {
    st = await stand({ modules: [chat()] });
    await st.open("site");
    mkdirSync(join(st.dir, "sub"), { recursive: true });
    for (let i = 0; i < 5; i++) writeFileSync(join(st.dir, "sub", `f${i}.txt`), "x");
    // часы уходят за предел между началом обхода и его шагами
    const now = st.clock.now.bind(st.clock);
    let asked = 0;
    st.clock.now = () => now() + (asked++ > 0 ? 6000 : 0);
    const r = await st.request("session.files", { to: CS, q: "f" }, PULT);
    st.clock.now = now;
    expect(r).toMatchObject({ ok: false, error: "timeout" });
  });
});

describe("находки: пределы шагов SDK на часах ядра", () => {
  const silent = () => new Promise(() => {});
  /** Функция SDK с этим именем молчит, остальные отвечают пусто. */
  const mute = (s: Stand, name: string) => {
    (s.sdk as any).functions = new Proxy({}, { get: (_t, n: string) => (n === name ? silent : async () => (n === "getSessionMessages" ? [] : {})) });
  };

  it("откат: Claude не ответил за предел шага — отказ sdk_error, сессия на прежнем разговоре", async () => {
    st = await stand({ modules: [chat()] });
    const { s } = await st.open("site");
    const sid = s.rec.sessionId;
    mute(st, "getSessionMessages");
    const asked = st.request("session.rewind", { to: CS, upto: "u1", dry: true }, PULT);
    await new Promise((r) => setTimeout(r, 50));
    st.clock.advance(30_000);
    expect(await asked).toMatchObject({ ok: false, error: "sdk_error" });
    expect(s.rec.sessionId).toBe(sid);
  });

  it("перечитывание: Claude не ответил за предел — отказ sdk_error", async () => {
    st = await stand({ modules: [chat()] });
    await st.open("site");
    (st.sdk.last(CS) as any).reloadPlugins = silent;
    const asked = st.request("session.call", { to: CS, method: "reload" }, PULT);
    await new Promise((r) => setTimeout(r, 50));
    st.clock.advance(30_000);
    expect(await asked).toMatchObject({ ok: false, error: "sdk_error" });
  });

  it("разговоры папки: список не получен за предел — отказ sdk_error", async () => {
    st = await stand({ modules: [chat()] });
    mute(st, "listSessions");
    const asked = st.request("machine.conversations", { to: "@laptop", cwd: st.dir }, PULT);
    await new Promise((r) => setTimeout(r, 50));
    st.clock.advance(30_000);
    expect(await asked).toMatchObject({ ok: false, error: "sdk_error" });
  });
});
