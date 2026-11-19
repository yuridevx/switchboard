// Эталоны «дать работу»: служба «Фабрика» отдаёт сессии шаг тикета; ход, взявший шаг, без вердикта возвращается один раз.
import { afterEach, describe, expect, it } from "vitest";
import { make as chat } from "../src/modules/chat/chat.ts";
import { make as work } from "../src/modules/work/work.ts";
import { FakeHolders, stand, tick, until, type FakeProc, type Stand } from "../stand/index.ts";

let st: Stand | undefined;
afterEach(async () => {
  await st?.stop();
  st = undefined;
});

const FACTORY = ".factory";
const PULT = "pult~yuri@example.com";
const give = (s: Stand, name: string, ticket: string, extra: Record<string, unknown> = {}) => s.request("work.give", { to: "@laptop", name, ticket, text: `Тикет ${ticket}: шапка сайта`, ...extra }, FACTORY);
/** Текст последнего ввода процесса. */
const lastInput = (p: FakeProc) => String(p.inputs.at(-1)!.message.content);
/** Ход взял ввод: процесс называет номера взятых сообщений на ответе модели; несколько шагов цикла событий — ядро успевает прочесть событие раньше хука. */
const take = async (p: FakeProc) => {
  p.send({ type: "assistant", uuid: "a" + p.inputs.length, message: { role: "assistant", content: [{ type: "text", text: "беру" }] }, user_message_uuids: [p.inputs.at(-1)!.uuid] });
  await tick(20);
};
const reminded = (out: unknown[]) => out.filter((o) => (o as { decision?: string } | undefined)?.decision === "block") as { reason: string }[];
const lines = (s: Stand) => s.journal().filter((l) => l.msg === "work");

describe("дать работу сессии", () => {
  // эталон 5 — чьё: факт (у Феникса письма остановленным сессиям терялись, 6 за день 16 ноября: отказ stopped никого не будит)
  it("5 · остановленную — поднять: тикет остановленной сессии запускает её и встаёт ей во ввод тегом вида ticket", async () => {
    st = await stand({ modules: [chat(), work()] });
    const { s } = await st.open("ops");
    expect((await st.request("session.stop", { to: "ops@laptop" })).ok).toBe(true);
    expect(s.state).toBe("stopped");
    // письмо остановленной — отказ; тикет — поднимает
    expect(await st.request("message", { to: "ops@laptop", text: "проверь ферму" }, PULT)).toMatchObject({ ok: false, error: "stopped" });
    expect(await give(st, "ops", "site-1", { step: "обход" })).toMatchObject({ ok: true, result: { callsign: "ops@laptop" } });
    await until(() => s.state === "idle" || s.state === "busy", 5000, "сессия поднята");
    const p = st.proc("ops@laptop");
    await until(() => p.inputs.length > 0, 5000, "ввод у процесса");
    expect(lastInput(p)).toBe('<fleet from=".factory" kind="ticket" ticket="site-1" step="обход">\nТикет site-1: шапка сайта\n</fleet>');
    expect(lines(st)).toMatchObject([{ callsign: "ops@laptop", kind: "given" }]);
  });

  // эталон 3 — чьё: факт (опыт на Haiku, выборка 1: без возврата шаг сдан 0 из 1, с ним — 1 из 1) и слово пользователя (пост говорит с человеком и берёт тикеты)
  it("3 · ход, взявший шаг, без вердикта возвращён один раз; ход с человеком не возвращается; сданный шаг напоминания не получает", async () => {
    st = await stand({ modules: [chat(), work()] });
    const { proc } = await st.open("cto");
    await give(st, "cto", "site-7");
    await until(() => proc.inputs.length === 1, 5000, "шаг во вводе");
    // пока ход шаг не взял, напоминать не о чем
    expect(reminded(await proc.hook("Stop", { stop_hook_active: false }))).toHaveLength(0);
    await take(proc);
    const blocks = reminded(await proc.hook("Stop", { stop_hook_active: false, background_tasks: [] }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.reason).toContain("site-7");
    expect(blocks[0]!.reason).toContain("ticket_set");
    // что возврат уже был, говорит сам хук: второго нет
    expect(reminded(await proc.hook("Stop", { stop_hook_active: true }))).toHaveLength(0);
    await st.turn("cto@laptop");
    // следом посту пишет человек: его ход кончается без напоминания, хотя тикет ещё не сдан
    await st.request("message", { to: "cto@laptop", text: "какой прогресс?" }, PULT);
    await until(() => proc.inputs.length === 2, 5000, "сообщение человека");
    await take(proc);
    expect(reminded(await proc.hook("Stop", { stop_hook_active: false }))).toHaveLength(0);
    await st.turn("cto@laptop");
    expect(lines(st).map((l) => l.kind)).toEqual(["given", "reminded"]);

    // второй шаг: идёт фоновая работа — ход ещё вернётся сам; вердикт ушёл — напоминать не о чем
    await give(st, "cto", "site-8");
    await until(() => proc.inputs.length === 3, 5000, "второй шаг");
    await take(proc);
    expect(reminded(await proc.hook("Stop", { stop_hook_active: false, background_tasks: [{ id: "b1" }] }))).toHaveLength(0);
    await proc.hook("PostToolUse", { tool_name: "mcp__fleet__ticket_set", tool_input: { ticket: "site-8", verdict: "done" } });
    expect(reminded(await proc.hook("Stop", { stop_hook_active: false }))).toHaveLength(0);
  });

  // эталон 16 — чьё: код (процесс сессии переживает подмену службы машины, ввод у него на руках)
  it("16 · машина перезапущена посреди шага: шаги у сессий те же, о шагах новый Host на старте не шлёт службам ни одного запроса", async () => {
    const holders = new FakeHolders();
    const first = await stand({ holders, modules: [chat(), work()] });
    const a = await first.open("dev-a");
    const b = await first.open("dev-b");
    await give(first, "dev-a", "site-1");
    await give(first, "dev-b", "site-2");
    await until(() => a.proc.inputs.length === 1 && b.proc.inputs.length === 1, 5000, "шаги во вводе");
    await first.kernel.shutdown("подмена");
    st = await stand({ holders, home: first.home, modules: [chat(), work()] });
    await until(() => st!.kernel.sessions.get("dev-a@laptop")!.state === "idle" && st!.kernel.sessions.get("dev-b@laptop")!.state === "idle", 5000, "attach");
    // процессы те же, ввод у них на руках: второй раз шаг не даётся
    expect(st.proc("dev-a@laptop")).toBe(a.proc);
    expect(a.proc.inputs).toHaveLength(1);
    expect(b.proc.inputs).toHaveLength(1);
    expect(st.services.calls.filter((f) => f.type.startsWith("ticket.") || f.type.startsWith("factory."))).toEqual([]);
    // сессия сдаёт шаг как обычно: новый Host ходу не мешает
    await take(a.proc);
    expect(reminded(await a.proc.hook("Stop", { stop_hook_active: false }))).toHaveLength(0);
  });

  it("работу даёт только служба «Фабрика»; сессии нет — отказ; сбой сессии с шагом на руках — тикету «стоп» с причиной", async () => {
    st = await stand({ modules: [chat(), work()] });
    const { proc, s } = await st.open("coder");
    expect(await st.request("work.give", { to: "@laptop", name: "coder", ticket: "site-1", text: "чужой" }, PULT)).toMatchObject({ ok: false, error: "forbidden" });
    expect(await give(st, "ghost", "site-1")).toMatchObject({ ok: false, error: "no_session" });
    await give(st, "coder", "site-3");
    await until(() => proc.inputs.length === 1, 5000, "шаг во вводе");
    await take(proc);
    // процесс умер, второй не поднялся: сессия failed — машина говорит службе, что шаг встал
    proc.exit(1, "упал");
    await until(() => st!.holders.procs.get("coder@laptop") !== proc && st!.holders.procs.get("coder@laptop")?.failInit !== undefined, 5000, "resume");
    const second = st.holders.procs.get("coder@laptop")!;
    second.failInit = true;
    second.exit(1, "не поднялся");
    await until(() => s.state === "failed", 5000, "failed");
    const told = await until(() => st!.services.of("ticket.set")[0], 5000, "вердикт машины");
    expect(told).toMatchObject({ ticket: "site-3", verdict: "stop" });
    expect(String(told.note)).toContain("сбоем");
    // сессии failed работу не дают
    expect(await give(st, "coder", "site-4")).toMatchObject({ ok: false, error: "failed" });
  });
});
