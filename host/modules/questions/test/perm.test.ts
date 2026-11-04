// Запрос разрешения и одобрение плана на стенде Host. Источник: цель пользователя 4 нояб. «чат со всеми фичами Claude»; формы — настоящий
// процесс claude 0.3.311 (проба: canUseTool приходит с suggestions, blockedPath, title; в bypass — не приходит). Настоящий режим сессии держит manage.
import { afterEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { make } from "../src/questions.ts";
import watchManifest from "../../watch/module.json" with { type: "json" };
import { make as makeWatch } from "../../watch/src/watch.ts";
import manageManifest from "../../manage/module.json" with { type: "json" };
import { manage } from "../../manage/src/manage.ts";

const { module, standHost, until } = stand;
const stands: stand.Stand[] = [];
afterEach(async () => {
  for (const s of stands.splice(0)) await s.close();
});

const CS = "profiles@laptop";

async function bench() {
  const notifies: Frame[] = [];
  const push = module("host-push", { requests: { notify: (req) => (notifies.push(req), { pushed: [] }) } });
  const slots = module("host-slots", { requests: { "session.slot": () => ({ restart: false }) } });
  const profiles = module("host-profiles", { requests: { "session.profile": () => ({}) } });
  const st = await standHost({
    modules: [
      slots,
      profiles,
      { manifest: manageManifest as Manifest, module: manage() },
      { manifest: watchManifest as Manifest, module: makeWatch() },
      push,
      { manifest: manifest as Manifest, module: make() },
    ],
  });
  stands.push(st);
  await st.open(CS);
  const p = st.proc(CS);
  await st.relay.request({ type: "session.watch", v: 1, callsign: CS, from: "pult~a@b" });
  return { st, p, notifies };
}

const mode = (p: { send(m: Record<string, unknown>): void }, permissionMode: string) => p.send({ type: "system", subtype: "status", status: null, permissionMode, uuid: crypto.randomUUID(), session_id: "s" });
const SUGGEST = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "localSettings" }];
const answer = (st: stand.Stand, o: Record<string, unknown>) => st.relay.request({ type: "answer", v: 1, callsign: CS, from: "pult~a@b", ...o });
const asked = (st: stand.Stand) => st.relay.frames("question");
const waitAsked = (st: stand.Stand) => until(() => asked(st).length > 0);

/** Режим уже виден модулю: session.spec его отдаёт. */
async function inMode(st: stand.Stand, p: { send(m: Record<string, unknown>): void }, m: string) {
  mode(p, m);
  await until(async () => ((await st.relay.request({ type: "session.spec", v: 1, callsign: CS })) as unknown as { result?: { mode?: string } }).result?.mode === m);
}

describe("запрос разрешения", () => {
  it("7100 · без вопросов (режим по умолчанию): запроса нет, инструмент разрешён сам — решение устава", async () => {
    const { st, p } = await bench();
    expect(await p.ask("Bash", { command: "npm test" })).toMatchObject({ behavior: "allow", updatedInput: { command: "npm test" } });
    expect(asked(st)).toHaveLength(0);
  });

  it("7101 · в режиме default: кадр question вида perm всем адресатам с инструментом, входом, заголовком, причиной и путём; ход ждёт человека", async () => {
    const { st, p, notifies } = await bench();
    await inMode(st, p, "default");
    let done = false;
    void p.ask("Bash", { command: "npm test", description: "Прогон" }, "toolu_p1").then(() => (done = true));
    await waitAsked(st);
    expect(asked(st)[0]).toMatchObject({ type: "question", from: CS, question: "toolu_p1", kind: "perm", tool: "Bash", input: { command: "npm test", description: "Прогон" } });
    expect(asked(st)[0].to).toContain("pult~a@b");
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    expect(notifies.at(-1)).toMatchObject({ frame: { notify: { title: `${CS} просит разрешения` } } });
    const list = (await st.relay.request({ type: "question.list", v: 1, callsign: CS })) as unknown as { result: Array<Record<string, unknown>> };
    expect(list.result).toEqual([expect.objectContaining({ question: "toolu_p1", kind: "perm", tool: "Bash" })]);
  });

  it("7102 · «Разрешить»: SDK получает allow с тем же входом, без постоянных правил; всем кадр answered", async () => {
    const { st, p } = await bench();
    await inMode(st, p, "default");
    const r = p.ask("Bash", { command: "ls" }, "toolu_p2");
    await waitAsked(st);
    expect(await answer(st, { question: "toolu_p2", action: "allow" })).toMatchObject({ ok: true });
    const got = await r;
    expect(got).toMatchObject({ behavior: "allow", updatedInput: { command: "ls" } });
    expect(got.updatedPermissions).toBeUndefined();
    expect(st.relay.frames("answered")[0]).toMatchObject({ question: "toolu_p2", by: "pult~a@b", action: "allow" });
  });

  it("7103 · «Разрешать всегда»: в ответ SDK — suggestions, что прислал сам SDK; свои правила клиент прислать не может", async () => {
    const { st, p } = await bench();
    await inMode(st, p, "default");
    const a = p.askWith("Bash", { command: "npm test" }, { suggestions: SUGGEST, blockedPath: "C:/x", title: "Claude хочет выполнить npm test", decisionReason: "нет правила" }, "toolu_p3");
    await waitAsked(st);
    expect(asked(st)[0]).toMatchObject({ suggestions: SUGGEST, blockedPath: "C:/x", title: "Claude хочет выполнить npm test", reason: "нет правила" });
    await answer(st, { question: "toolu_p3", action: "allow", always: true, updatedPermissions: [{ type: "setMode", mode: "bypassPermissions" }] });
    expect((await a).updatedPermissions).toEqual(SUGGEST);
  });

  it("7104 · «Отклонить» с причиной: deny со словами человека; без причины — своё слово; ход не прерван", async () => {
    const { st, p } = await bench();
    await inMode(st, p, "default");
    const a = p.ask("Bash", { command: "rm x" }, "toolu_p4");
    await waitAsked(st);
    await answer(st, { question: "toolu_p4", action: "deny", message: "не трогай" });
    expect(await a).toEqual({ behavior: "deny", message: "Пользователь отклонил: не трогай" });
    const b = p.ask("Bash", { command: "rm y" }, "toolu_p5");
    await until(() => asked(st).length > 1);
    await answer(st, { question: "toolu_p5", action: "deny" });
    expect(await b).toEqual({ behavior: "deny", message: "Пользователь отклонил" });
  });

  it("7105 · второй ответ — already_answered; неизвестное действие — bad_frame, вопрос остаётся открытым", async () => {
    const { st, p } = await bench();
    await inMode(st, p, "default");
    const a = p.ask("Bash", { command: "ls" }, "toolu_p6");
    await waitAsked(st);
    expect(await answer(st, { question: "toolu_p6", action: "accept" })).toMatchObject({ ok: false, error: "bad_frame" });
    await answer(st, { question: "toolu_p6", action: "allow" });
    await a;
    expect(await answer(st, { question: "toolu_p6", action: "deny" })).toMatchObject({ ok: false, error: "already_answered" });
  });

  it("7106 · ход прервали: вопрос снят, SDK получает deny, адресаты — answered cancelled; ответа за человека нет", async () => {
    const { st, p } = await bench();
    await inMode(st, p, "default");
    const a = p.ask("Bash", { command: "ls" }, "toolu_p7");
    await waitAsked(st);
    p.abortAsk("toolu_p7");
    expect(await a).toMatchObject({ behavior: "deny", message: "cancelled" });
    expect(st.relay.frames("answered")[0]).toMatchObject({ question: "toolu_p7", cancelled: true });
  });

  it("7107 · AskUserQuestion по-прежнему вид ask, и в режиме default, и без вопросов", async () => {
    const { st, p } = await bench();
    await inMode(st, p, "default");
    void p.ask("AskUserQuestion", { questions: [{ question: "База?", options: [{ label: "а" }] }] }, "toolu_q");
    await waitAsked(st);
    expect(asked(st)[0]).toMatchObject({ kind: "ask", question: "toolu_q" });
  });
});

describe("план", () => {
  const PLAN = { plan: "## План\n\n1. Шаг" };

  it("7110 · ExitPlanMode в режиме plan — запрос с текстом плана", async () => {
    const { st, p } = await bench();
    await inMode(st, p, "plan");
    void p.ask("ExitPlanMode", PLAN, "toolu_e1");
    await waitAsked(st);
    expect(asked(st)[0]).toMatchObject({ kind: "perm", tool: "ExitPlanMode", input: PLAN });
  });

  it("7111 · «Одобрить и разрешать правки»: allow и смена режима на acceptEdits в этой сессии", async () => {
    const { st, p } = await bench();
    await inMode(st, p, "plan");
    const a = p.ask("ExitPlanMode", PLAN, "toolu_e2");
    await waitAsked(st);
    await answer(st, { question: "toolu_e2", action: "allow", always: true });
    expect(await a).toMatchObject({ behavior: "allow", updatedInput: PLAN, updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] });
  });

  it("7112 · «Вернуть с замечаниями»: deny, Claude получает замечания", async () => {
    const { st, p } = await bench();
    await inMode(st, p, "plan");
    const a = p.ask("ExitPlanMode", PLAN, "toolu_e3");
    await waitAsked(st);
    await answer(st, { question: "toolu_e3", action: "deny", message: "добавь тест" });
    expect(await a).toEqual({ behavior: "deny", message: "Пользователь вернул план: добавь тест" });
  });
});
