// План тестов v2, разговор сессии: отказы словом, ответы на вопросы, вести и откат — свойства, которых не держал ни один тест.
// Источник свойств — устав («система ловит», закрытый список веток) и код (помечено «чьё: код»).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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
const CS = "site@laptop";
const user = (uuid: string, content: unknown) => ({ type: "user", uuid, message: { role: "user", content } });
const bot = (uuid: string, text: string) => ({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text }] } });
const SIX = [user("h1", "Почини меню"), bot("a1", "починил"), user("h2", "Теперь подвал"), bot("a2", "сделал"), user("h3", "И шапку"), bot("a3", "готово")];
/** Функции SDK о разговоре отвечают этими записями. */
function withTalk(s: Stand, said: unknown[]): void {
  (s.sdk as any).functions = new Proxy({}, { get: (_t, name: string) => async () => (name === "getSessionMessages" ? said : {}) });
}
const events = (s: Stand) => s.link.of("session.events").flatMap((f) => f.events as any[]);
const row = (cs: string) => st!.link.rows(cs).at(-1)!.row as any;
const busy = async (cs: string) => {
  st!.proc(cs).busy = true;
  st!.proc(cs).send({ type: "system", subtype: "session_state_changed", state: "running", session_id: "s" });
  await until(() => st!.kernel.sessions.get(cs)!.state === "busy", 5000, `${cs} busy`);
};

describe("план v2: сообщения", () => {
  // чьё: код — родитель ждёт итог хода дочери сам, отдельно писать ему не надо
  it("родитель даёт задачу дочери: во вводе — обёртка и приписка «итог уйдёт сам»", async () => {
    st = await stand({ modules: [chat()] });
    await st.open("lead");
    await st.open("kid", {}, "lead@laptop");
    await st.request("message", { to: "kid@laptop", text: "собери отчёт" }, "lead@laptop");
    const got = String((await until(() => st!.proc("kid@laptop").inputs.at(-1), 5000, "ввод дочери")).message.content);
    expect(got).toContain('<fleet-message from="lead@laptop">');
    expect(got).toContain("итог этого хода уйдёт ему сам");
  });

  it("отмена сообщения: Claude отказал — sdk_error с позывным, сообщение остаётся в очереди", async () => {
    st = await stand({ modules: [chat()] });
    const { q } = await st.open("site");
    await busy(CS);
    const uuid = ((await st.request("message", { to: CS, text: "ещё одно" }, PULT)).result as any).uuid as string;
    (q as any).cancelAsyncMessage = async () => {
      throw new Error("нет связи с процессом");
    };
    const r = await st.request("message.cancel", { to: CS, uuid }, PULT);
    expect(r).toMatchObject({ ok: false, error: "sdk_error" });
    expect(String((r as any).why)).toContain(CS);
    expect((await st.request("session.watch", { to: CS }, PHONE)).result).toMatchObject({ queued: [{ uuid }] });
  });

  it("история: записи с таким номером в разговоре нет — not_found", async () => {
    st = await stand({ modules: [chat()] });
    await st.open("site");
    withTalk(st, SIX);
    expect(await st.request("session.history", { to: CS, before: "нет-такой" }, PULT)).toMatchObject({ ok: false, error: "not_found" });
  });

  // чьё: код — подсказка файлов для «@»: в git скрытое .gitignore не показывается, новое — показывается
  it("файлы папки в git: новый файл есть, скрытого .gitignore нет", async () => {
    st = await stand({ modules: [chat()] });
    await st.open("site");
    execFileSync("git", ["init", "-q"], { cwd: st.dir });
    writeFileSync(join(st.dir, ".gitignore"), "secret-Notes.txt\n");
    writeFileSync(join(st.dir, "secret-Notes.txt"), "x");
    writeFileSync(join(st.dir, "release-NOTES.md"), "x");
    const r = await st.request("session.files", { to: CS, q: "notes" }, PULT);
    expect((r.result as { files: string[] }).files).toEqual(["release-NOTES.md"]);
  });

  // чьё: код
  it("session.unwatch: ушедшему зрителю лента не идёт, оставшемуся — идёт", async () => {
    st = await stand({ modules: [chat()] });
    const { proc } = await st.open("site");
    await st.request("session.watch", { to: CS }, PULT);
    await st.request("session.watch", { to: CS }, PHONE);
    expect(await st.request("session.unwatch", { to: CS }, PULT)).toMatchObject({ ok: true });
    proc.send(bot("a1", "привет"));
    const f = await until(() => st!.link.of("session.events")[0], 5000, "пачка");
    expect(f.to).toEqual([PHONE]);
  });
});

describe("план v2: вопросы и разрешения", () => {
  const ask = async (name: string, tool: string, input: Record<string, unknown>, id: string, opts: Record<string, unknown> = {}, mode = "ask") => {
    const { proc } = await st!.open(name, { mode });
    const asked = proc.askWith(tool, input, opts, id);
    await until(() => row(`${name}@laptop`).ask, 5000, "вопрос в строке");
    return { asked };
  };
  const RULE = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm run build" }], behavior: "allow", destination: "session" }];

  // чьё: код
  it("разрешение: allow — разрешено; allow_always — с правилом из предложений Claude; подпись кнопки — то же действие; deny — с причиной человека", async () => {
    st = await stand({ modules: [chat()] });
    const { asked: a } = await ask("a", "Bash", { command: "npm run build" }, "p-a", { suggestions: RULE });
    await st.request("answer", { to: "a@laptop", ask: "p-a", answer: "allow" }, PULT);
    expect(await a).toEqual({ behavior: "allow", updatedInput: { command: "npm run build" } });

    const { asked: b } = await ask("b", "Bash", { command: "npm run build" }, "p-b", { suggestions: RULE });
    await st.request("answer", { to: "b@laptop", ask: "p-b", answer: { action: "allow_always" } }, PULT);
    expect(await b).toEqual({ behavior: "allow", updatedInput: { command: "npm run build" }, updatedPermissions: RULE });

    const { asked: c } = await ask("c", "Bash", { command: "npm run build" }, "p-c", { suggestions: RULE });
    await st.request("answer", { to: "c@laptop", ask: "p-c", answer: "Разрешать всегда" }, PULT);
    expect(await c).toMatchObject({ behavior: "allow", updatedPermissions: RULE });

    const { asked: d } = await ask("d", "Bash", { command: "rm -rf dist" }, "p-d");
    await st.request("answer", { to: "d@laptop", ask: "p-d", answer: "Отклонить" }, PULT);
    expect(await d).toMatchObject({ behavior: "deny" });
  });

  // чьё: код — одобрить план и дальше не спрашивать о правках
  it("план ExitPlanMode: в строке вопрос вида plan с текстом плана; «разрешать всегда» — режим acceptEdits", async () => {
    st = await stand({ modules: [chat()] });
    const { asked } = await ask("site", "ExitPlanMode", { plan: "1. Починить меню\n2. Тесты" }, "p-1", {}, "plan");
    expect(row(CS).ask).toMatchObject({ kind: "plan", text: "1. Починить меню\n2. Тесты" });
    await st.request("answer", { to: CS, ask: "p-1", answer: { action: "allow_always" } }, PULT);
    expect(await asked).toMatchObject({ behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "acceptEdits" }] });
  });

  // устав: graceful shutdown — «доводит или отдаёт текущее»
  it("ход снял вопрос: его нет в строке, в ленте — «cancelled», Claude получил deny; поздний ответ — already_answered", async () => {
    st = await stand({ modules: [chat()] });
    const { asked } = await ask("site", "Bash", { command: "rm -rf dist" }, "p-1");
    await st.request("session.watch", { to: CS }, PULT);
    st.proc(CS).abortAsk("p-1");
    expect(await asked).toEqual({ behavior: "deny", message: "cancelled" });
    await until(() => row(CS).ask === null, 5000, "вопрос ушёл из строки");
    await until(() => events(st!).some((e) => e.type === "ask.answered" && e.ask === "p-1" && e.answer === "cancelled"), 5000, "событие в ленте");
    expect(await st.request("answer", { to: CS, ask: "p-1", answer: "allow" }, PULT)).toMatchObject({ ok: false, error: "already_answered" });
  });
});

describe("план v2: вести", () => {
  // устав: закрытый список — «второй сбой до готовности — failed»; о сбое узнаёт тот, кто дал задачу
  it("сессия упала со сбоем — один reach.send «failed» тому, кто дал задачу", async () => {
    st = await stand({ modules: [chat()] });
    const { s, proc } = await st.open("site");
    await st.request("message", { to: CS, text: "работай" }, PULT);
    st.holders.failInitNext = 1;
    proc.exit(1, "упал");
    await until(() => st!.holders.procs.get(CS)?.failInit, 5000, "неготовый процесс");
    st.holders.procs.get(CS)!.exit(1, "не поднялся");
    await until(() => s.state === "failed", 5000, "failed");
    await until(() => st!.services.of("reach.send").length === 1, 5000, "reach.send");
    expect(st.services.of("reach.send")[0]).toMatchObject({ to: "~yuri@example.com", kind: "failed", callsign: CS });
    await tick();
    expect(st.services.of("reach.send")).toHaveLength(1);
  });

  // устав: «процесс claude умер — один resume»; слово пользователя: ведущая узнаёт событиями
  it("процесс ведомого умер и поднят — ведущей весть «снова на связи»", async () => {
    st = await stand({ modules: [chat()] });
    await st.request("session.open", { to: "@laptop", spec: { name: "lead", cwd: st.dir }, pair: true }, PULT);
    const wing = st.kernel.sessions.get("lead-wing@laptop")!;
    const before = st.proc("lead@laptop").inputs.length;
    st.proc("lead-wing@laptop").exit(1, "упал");
    await until(() => st!.holders.spawns.filter((x) => x.id === "lead-wing@laptop").length === 2 && wing.state === "idle", 5000, "resume ведомого");
    await until(() => st!.proc("lead@laptop").inputs.slice(before).some((i) => String(i.message.content).includes("снова на связи")), 5000, "весть «снова на связи»");
  });
});

describe("план v2: отказы отката", () => {
  it("ход не прервался за предел — busy: откат не начат, процесс и разговор прежние", async () => {
    st = await stand({ modules: [chat()] });
    await st.open("site");
    withTalk(st, SIX);
    await busy(CS);
    st.proc(CS).noInterrupt = true;
    const rewinding = st.request("session.rewind", { to: CS, upto: "h3" }, PULT);
    await until(() => st!.proc(CS).interrupts === 1, 5000, "прерывание ушло");
    st.clock.advance(30_000);
    expect(await rewinding).toMatchObject({ ok: false, error: "busy" });
    expect(st.holders.spawns).toHaveLength(1);
    expect(st.kernel.sessions.get(CS)!.rec.upto).toBeUndefined();
  });

  // закрытый список: «процесс claude умер — один resume, второй сбой до готовности — failed»
  it("процесс не поднялся на обрезанном разговоре — open_failed; дальше ветка сбоя процесса с той же обрезкой", async () => {
    st = await stand({ modules: [chat()] });
    const { s } = await st.open("site");
    withTalk(st, SIX);
    st.holders.failInitNext = 2;
    const rewinding = st.request("session.rewind", { to: CS, upto: "h3" }, PULT);
    await until(() => st!.holders.spawns.length === 2 && st!.holders.procs.get(CS)?.initializes === 1, 5000, "новый процесс");
    st.holders.procs.get(CS)!.exit(1, "упал до готовности");
    expect(await rewinding).toMatchObject({ ok: false, error: "open_failed" });
    await until(() => st!.holders.spawns.length === 3 && st!.holders.procs.get(CS)?.initializes === 1, 5000, "resume");
    expect(st.sdk.last(CS)!.options).toMatchObject({ resumeSessionAt: "a2" });
    st.holders.procs.get(CS)!.exit(1, "упал снова");
    await until(() => s.state === "failed", 5000, "failed");
  });
});
