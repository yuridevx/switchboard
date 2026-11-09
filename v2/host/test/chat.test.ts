import { afterEach, describe, expect, it } from "vitest";
import { make as chat } from "../src/modules/chat/chat.ts";
import { stand, tick, until, type Stand } from "../stand/index.ts";

let st: Stand | undefined;
afterEach(async () => {
  await st?.stop();
  st = undefined;
});

const PULT = "pult~yuri@example.com";
const PHONE = "phone~yuri@example.com";
const ANYA = "pult~anya@example.com";

describe("chat", () => {
  it("сообщение человека идёт как есть, сообщение сессии — с пометкой отправителя", async () => {
    st = await stand({ modules: [chat()] });
    const { proc } = await st.open("site");
    expect((await st.request("message", { to: "site@laptop", text: "привет" }, PULT)).ok).toBe(true);
    expect((await st.request("message", { to: "site@laptop", text: "я закончила" }, "docs@server")).ok).toBe(true);
    await until(() => proc.inputs.length === 2, 5000, "ввод");
    expect(proc.inputs[0]!.message.content).toBe("привет");
    expect(proc.inputs[1]!.message.content).toBe('<fleet-message from="docs@server">\nя закончила\n</fleet-message>');
  });

  it("вложение-картинка идёт блоком; тип без блока — отказ bad_attachment, во ввод ничего не ушло", async () => {
    st = await stand({ modules: [chat()] });
    const { proc } = await st.open("site");
    await st.request("message", { to: "site@laptop", text: "смотри", files: [{ name: "a.png", mime: "image/png", base64: "AAAA" }] });
    await until(() => proc.inputs.length === 1, 5000, "ввод");
    expect(proc.inputs[0]!.message.content).toEqual([{ type: "text", text: "смотри" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }]);
    const bad = await st.request("message", { to: "site@laptop", text: "x", files: [{ name: "a.zip", mime: "application/zip", base64: "AAAA" }] });
    expect(bad).toMatchObject({ ok: false, error: "bad_attachment" });
    await tick(10);
    expect(proc.inputs).toHaveLength(1);
  });

  it("ход на 1 000 событий даёт ровно 2 изменения строки", async () => {
    st = await stand({ modules: [chat()] });
    await st.open("site");
    await st.request("message", { to: "site@laptop", text: "работай" });
    const before = st.link.rows("site@laptop").length;
    const events = Array.from({ length: 1000 }, (_, i) => ({ type: "assistant", uuid: `u${i}`, message: { content: [{ type: "text", text: `шаг ${i}` }] } }));
    await st.turn("site@laptop", events, "сделано");
    await tick(20);
    const rows = st.link.rows("site@laptop").slice(before);
    expect(rows.map((f) => (f.row as any).state)).toEqual(["busy", "idle"]);
    expect(rows[1]!.row).toMatchObject({ result: "сделано", unread: ["~yuri@example.com"] });
  });

  it("лента: события пачкой только тем, кто смотрит; зритель ушёл — лента не идёт", async () => {
    st = await stand({ modules: [chat()] });
    const { proc } = await st.open("site");
    expect(await st.request("session.watch", { to: "site@laptop" }, PULT)).toMatchObject({ ok: true, result: { seq: expect.any(Number) } });
    proc.send({ type: "assistant", uuid: "a1", message: { content: [] } });
    proc.send({ type: "assistant", uuid: "a2", message: { content: [] } });
    const f = await until(() => st!.link.of("session.events")[0], 5000, "пачка");
    expect(f).toMatchObject({ to: [PULT], callsign: "site@laptop" });
    expect((f.events as any[]).map((e) => e.uuid)).toEqual(["a1", "a2"]);
    st.link.deliver({ type: "watcher.gone", from: PULT });
    const n = st.link.of("session.events").length;
    proc.send({ type: "assistant", uuid: "a3", message: { content: [] } });
    await new Promise((r) => setTimeout(r, 150));
    expect(st.link.of("session.events")).toHaveLength(n);
  });

  it("«прочитано» с одного устройства снимает пометку у человека; чужая пометка остаётся", async () => {
    st = await stand({ modules: [chat()] });
    await st.open("site");
    await st.request("message", { to: "site@laptop", text: "раз" }, PULT);
    await st.request("message", { to: "site@laptop", text: "два" }, ANYA);
    await st.turn("site@laptop");
    expect(st.link.rows("site@laptop").at(-1)!.row).toMatchObject({ unread: ["~yuri@example.com", "~anya@example.com"] });
    expect((await st.request("session.read", { to: "site@laptop" }, PHONE)).ok).toBe(true);
    expect((st.link.rows("site@laptop").at(-1)!.row as any).unread).toEqual(["~anya@example.com"]);
  });

  it("кто смотрит сессию в конце хода, тому непрочитанное не ставится", async () => {
    st = await stand({ modules: [chat()] });
    await st.open("site");
    await st.request("message", { to: "site@laptop", text: "раз" }, PULT);
    await st.request("session.watch", { to: "site@laptop" }, PHONE);
    await st.turn("site@laptop");
    expect((st.link.rows("site@laptop").at(-1)!.row as any).unread).toEqual([]);
  });

  it("вопрос живёт в строке сессии; человека зовут одним reach.send; два ответа — второй already_answered", async () => {
    st = await stand({ modules: [chat()] });
    const { proc } = await st.open("site");
    await st.request("message", { to: "site@laptop", text: "выкладывай" }, PULT);
    const input = { questions: [{ question: "Какую ветку выкладывать?", options: [{ label: "main" }, { label: "release" }] }] };
    const asked = proc.ask("AskUserQuestion", input, "q-9");
    await until(() => (st!.link.rows("site@laptop").at(-1)!.row as any).ask, 5000, "вопрос в строке");
    expect(st.link.rows("site@laptop").at(-1)!.row).toMatchObject({ ask: { id: "q-9", kind: "question", text: "Какую ветку выкладывать?", options: [{ label: "main" }, { label: "release" }] } });
    await until(() => st!.services.of("reach.send").length === 1, 5000, "reach.send");
    expect(st.services.of("reach.send")[0]).toMatchObject({ to: "~yuri@example.com", kind: "ask", callsign: "site@laptop", text: "Какую ветку выкладывать?" });
    const first = await st.request("answer", { to: "site@laptop", ask: "q-9", answer: "main" }, PHONE);
    const second = await st.request("answer", { to: "site@laptop", ask: "q-9", answer: "release" }, PULT);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, error: "already_answered" });
    expect(await asked).toEqual({ behavior: "allow", updatedInput: { ...input, answers: { "Какую ветку выкладывать?": "main" } } });
    expect((st.link.rows("site@laptop").at(-1)!.row as any).ask).toBeNull();
    expect(await st.request("answer", { to: "site@laptop", ask: "q-0", answer: "x" }, PULT)).toMatchObject({ ok: false, error: "unknown_question" });
    expect(st.services.of("reach.send")).toHaveLength(1);
  });

  it("режим «разрешено всё» инструмент разрешает сам; режим ask — разрешение решает только человек", async () => {
    st = await stand({ modules: [chat()] });
    const { proc } = await st.open("site");
    expect(await proc.ask("Bash", { command: "ls" })).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
    const { proc: careful } = await st.open("careful", { mode: "ask" });
    const asked = careful.ask("Bash", { command: "rm -rf x" }, "p-1");
    await until(() => (st!.link.rows("careful@laptop").at(-1)!.row as any).ask, 5000, "разрешение в строке");
    expect(await st.request("answer", { to: "careful@laptop", ask: "p-1", answer: "allow" }, "docs@server")).toMatchObject({ ok: false, error: "not_client" });
    expect((await st.request("answer", { to: "careful@laptop", ask: "p-1", answer: { action: "deny", message: "не надо" } }, PULT)).ok).toBe(true);
    expect(await asked).toMatchObject({ behavior: "deny", message: expect.stringContaining("не надо") });
  });

  it("конец хода: один reach.send тому, кто дал задачу", async () => {
    st = await stand({ modules: [chat()] });
    await st.open("site");
    await st.request("message", { to: "site@laptop", text: "работай" }, PULT);
    await st.turn("site@laptop", [], "готово: 3 файла");
    await until(() => st!.services.of("reach.send").length === 1, 5000, "reach.send");
    expect(st.services.of("reach.send")[0]).toMatchObject({ to: "~yuri@example.com", kind: "done", text: "готово: 3 файла", callsign: "site@laptop" });
  });

  it("история страницами с конца; у остановленной сессии сообщение — отказ stopped", async () => {
    st = await stand({ modules: [chat()] });
    await st.open("site");
    const r = await st.request("session.history", { to: "site@laptop", limit: 10 });
    expect(r).toMatchObject({ ok: true, result: { events: [], more: false } });
    await st.request("session.stop", { to: "site@laptop" });
    expect(await st.request("message", { to: "site@laptop", text: "эй" })).toMatchObject({ ok: false, error: "stopped" });
  });
});
