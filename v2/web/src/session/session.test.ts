// Разговор с сессией: чистая логика — свёртка ленты, статусы своих сообщений, номера ленты, вопросы, документ, новая сессия — и формы мока, равные формам Host.
import { createApi, message, messageCancel, sessionCall, sessionHistory, sessionOpen, sessionUpdate, sessionWatch, type Ask, type Frame, type MachineRow, type SessionRow } from "@sb/protocol";
import { describe, expect, it } from "vitest";
import { exportMd, focused } from "../chat/focus.ts";
import { fold, todoProgress } from "../chat/fold.ts";
import { agentSteps, editStat } from "../chat/tools.ts";
import { researchTurn, siteTurn } from "../mock/convo.ts";
import { createMock } from "../mock/fleet.ts";
import { freeName, nameOf, piecesFor, pushPlace, sortMachines, splitPath } from "../shell/NewSession.tsx";
import { actionAnswer, answeredAll, formAnswer, formFields, formReady, questionAnswer, questionSaid, questionsOf } from "../chat/answers.ts";
import { commandPicks, sideQuestion } from "./Composer.tsx";
import { effectiveModel, mergeLater, modelOptions } from "./doc.ts";
import { looksHtml, textOf } from "./html.tsx";
import { bindLocal, draft, mergeEvents, missed } from "./talk.ts";

const T = 1_800_000_000_000;
const quiet = () => createMock({ now: () => T, live: false, latency: 0 });
const say = (uuid: string, text: string, extra = {}) => ({ type: "user", uuid, message: { role: "user", content: text }, ...extra });
const reply = (uuid: string, text: string) => ({ type: "assistant", uuid, message: { id: "m" + uuid, content: [{ type: "text", text }] } });
const delta = (type: "text_delta" | "thinking_delta", text: string) => ({ type: "stream_event", event: { type: "content_block_delta", delta: type === "text_delta" ? { type, text } : { type, thinking: text } } });

describe("лента: живой ответ", () => {
  it("поток: текст растёт с пометкой «идёт»; готовое сообщение заменяет его без пометки", () => {
    const start = { type: "stream_event", event: { type: "message_start", message: { id: "msg1" } } };
    const live = fold([say("1", "Привет"), start, delta("thinking_delta", "Думаю"), delta("text_delta", "Пишу "), delta("text_delta", "ответ")]);
    const r = live.rows.at(-1)!;
    expect(r).toMatchObject({ k: "reply", parts: [{ k: "think", text: "Думаю", live: true }, { k: "text", text: "Пишу ответ", live: true }] });
    const done = fold([say("1", "Привет"), start, delta("text_delta", "Пишу ответ"), { type: "assistant", uuid: "2", message: { id: "msg1", content: [{ type: "text", text: "Пишу ответ целиком" }] } }]);
    expect(done.rows.at(-1)).toMatchObject({ k: "reply", parts: [{ k: "text", text: "Пишу ответ целиком" }] });
    expect((done.rows.at(-1) as any).parts[0].live).toBeUndefined();
  });
  it("«Размышляет…» и «Сжимаю контекст…» — состояние вида, не строки ленты", () => {
    const v = fold([say("1", "Привет"), { type: "system", subtype: "thinking_tokens", estimated_tokens: 120 }, { type: "system", subtype: "status", status: "compacting" }]);
    expect(v.thinking).toBe(120);
    expect(v.compacting).toBe(true);
    expect(v.rows.length).toBe(1);
    expect(fold([say("1", "Привет"), { type: "system", subtype: "status", status: "compacting" }, { type: "result", uuid: "2" }]).compacting).toBe(false);
  });
});

describe("лента: свои сообщения и отправители", () => {
  it("статус Host: «в очереди» снимает поставленную страницей строку «ход закончен»; «взято» и «отменено» меняют пометку", () => {
    const base = [say("1", "Начни"), reply("2", "Работаю"), say("m1", "И подвал", { from: "pult~yuri@example.com" })];
    // без статуса новое сообщение закрывает прошлый ход
    expect(fold(base).rows.map((r) => r.k)).toEqual(["me", "reply", "res", "me"]);
    const queued = fold([...base, { type: "message.status", uuid: "m1", status: "queued" }]);
    expect(queued.rows.map((r) => r.k)).toEqual(["me", "reply", "me"]);
    expect(queued.rows[2]).toMatchObject({ state: "queued", from: "pult~yuri@example.com" });
    expect(fold([...base, { type: "message.status", uuid: "m1", status: "queued" }, { type: "message.status", uuid: "m1", status: "taken" }]).rows[2]).toMatchObject({ state: "taken" });
    expect(fold([...base, { type: "message.status", uuid: "m1", status: "queued" }, { type: "message.status", uuid: "m1", status: "cancelled" }]).rows[2]).toMatchObject({ state: "cancelled" });
    // конец хода не переводит в «отправлено» то, о чём уже сказал Host
    expect(fold([...base, { type: "message.status", uuid: "m1", status: "queued" }, { type: "result", uuid: "9" }]).rows.find((r) => r.k === "me" && r.uuid === "m1")).toMatchObject({ state: "queued" });
  });
  it("сообщение службы — строка с отправителем; документ — именем файла; картинка — картинкой", () => {
    const v = fold([
      say("1", "Диск /var занят на 91%", { from: ".incidents" }),
      { type: "user", uuid: "2", message: { role: "user", content: [{ type: "text", text: "Смотри" }, { type: "document", title: "отчёт.pdf", source: { type: "base64", media_type: "application/pdf", data: "AAAA" } }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } }] } },
    ]);
    expect(v.rows[0]).toMatchObject({ k: "in", via: "service", from: ".incidents", text: "Диск /var занят на 91%" });
    expect(v.rows[1]).toMatchObject({ k: "me", text: "Смотри", files: ["отчёт.pdf"], pics: ["data:image/png;base64,iVBOR"] });
  });
  it("своё сообщение получает номер сессии; запись ленты с этим номером не даёт повтора", () => {
    const mine = { type: "user", uuid: "local-1", message: { role: "user", content: "И подвал" }, _local: true, _state: "sending" };
    const bound = bindLocal([say("1", "Начни"), mine], "local-1", "m7", "queued");
    expect(bound.map((e) => e.uuid)).toEqual(["1", "m7"]);
    expect(bound[1]).toMatchObject({ _state: "queued", _local: true });
    expect(mergeEvents(bound, [say("m7", "И подвал", { from: "pult~yuri@example.com" })])).toBe(bound);
    // лента успела раньше ответа на запрос — показанное заранее убирается
    expect(bindLocal([say("m7", "И подвал"), mine], "local-1", "m7", "sent").map((e) => e.uuid)).toEqual(["m7"]);
    expect(fold(bound).rows.at(-1)).toMatchObject({ k: "me", state: "queued" });
    expect(fold([say("1", "Начни"), { ...mine, _state: "lost" }]).rows.at(-1)).toMatchObject({ state: "lost" });
  });
  it("пропуск в ленте считается по номерам", () => {
    expect(missed(10, 12, 2)).toBe(0);
    expect(missed(10, 15, 2)).toBe(3);
    expect(missed(10, 9, 1)).toBe(0);
  });
});

describe("инструменты и фокус", () => {
  it("правка — счёт строк; субагент — число шагов; список дел — сколько готово", () => {
    expect(editStat({ id: "1", name: "Edit", input: { old_string: "a\nb", new_string: "a\nb\nc" }, steps: [] })).toEqual({ plus: 3, minus: 2 });
    expect(editStat({ id: "1", name: "Write", input: { content: "x\ny" }, steps: [] })).toEqual({ plus: 2, minus: 0 });
    expect(editStat({ id: "1", name: "Bash", input: {}, steps: [] })).toBeNull();
    const v = fold(researchTurn(T, "Разберись"));
    expect(agentSteps(Object.values(v.tools).find((t) => t.name === "Task")!)).toBe(2);
    expect(todoProgress([{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c", status: "pending" }])).toEqual({ done: 1, of: 3 });
  });
  it("фокус: ход — сообщение, одна строка шагов, итоговый текст и итог; выгрузка — markdown с ролями", () => {
    const v = fold(siteTurn(T, "Почини шапку"));
    const f = focused(v);
    expect(f.map((r) => r.k)).toEqual(["me", "steps", "reply", "res"]);
    expect(f[1]).toMatchObject({ k: "steps" });
    expect((f[1] as any).title).toMatch(/шаг/);
    expect((f[2] as any).parts).toHaveLength(1);
    const md = exportMd("site@laptop", v);
    expect(md).toMatch(/^# site@laptop/);
    expect(md).toContain("## Вы\n\nПочини шапку");
    expect(md).toContain("## Claude");
  });
  it("HTML узнаётся по языку блока и по началу документа; текст кода достаётся из дерева подсветки", () => {
    expect(looksHtml("html", "<p>x</p>")).toBe(true);
    expect(looksHtml("", "<!doctype html><html></html>")).toBe(true);
    expect(looksHtml("ts", "<html>")).toBe(false);
    expect(textOf(["a", 1, null, ["b"]])).toBe("a1b");
  });
});

describe("вопросы человеку", () => {
  const ask = (a: Partial<Ask>): Ask => ({ id: "q1", kind: "question", text: "Какую ветку?", at: T, ...a });
  it("несколько вопросов берутся из ввода инструмента; ответ — по тексту каждого вопроса, несколько выбранных — через запятую", () => {
    const qs = questionsOf(ask({ input: { questions: [{ question: "Ветка?", header: "Ветка", options: [{ label: "main", description: "зелёная" }] }, { question: "Что проверить?", multiSelect: true, options: [{ label: "тесты" }, { label: "снимки" }] }] } }));
    expect(qs).toHaveLength(2);
    expect(qs[0]).toMatchObject({ question: "Ветка?", header: "Ветка", multi: false, options: [{ label: "main", about: "зелёная" }] });
    expect(qs[1].multi).toBe(true);
    const picked = [["main"], ["тесты", "снимки"]];
    expect(questionAnswer(qs, picked)).toEqual({ answers: { "Ветка?": "main", "Что проверить?": "тесты, снимки" } });
    expect(questionSaid(picked)).toBe("main; тесты, снимки");
    expect(answeredAll(qs, [["main"], []])).toBe(false);
    // один вопрос без ввода инструмента — из строки сессии
    expect(questionsOf(ask({ options: [{ label: "main" }], multi: true }))).toEqual([{ question: "Какую ветку?", multi: true, options: [{ label: "main" }] }]);
  });
  it("разрешение и план: действие и причина отказа", () => {
    expect(actionAnswer("allow")).toEqual({ action: "allow" });
    expect(actionAnswer("allow_always", "лишнее")).toEqual({ action: "allow_always" });
    expect(actionAnswer("deny", "  не трогай dist ")).toEqual({ action: "deny", message: "не трогай dist" });
  });
  it("форма: поля по схеме; пустые необязательные не уходят; обязательные держат кнопку", () => {
    const fields = formFields({ type: "object", required: ["host"], properties: { host: { type: "string", title: "Сервер" }, port: { type: "integer", default: 587 }, tls: { type: "boolean" }, kind: { enum: ["smtp", "api"], enumNames: ["SMTP", "API"] }, note: { type: "string" } } });
    expect(fields.map((f) => [f.key, f.type, f.required])).toEqual([["host", "string", true], ["port", "number", false], ["tls", "boolean", false], ["kind", "enum", false], ["note", "string", false]]);
    expect(fields[3].options).toEqual([{ value: "smtp", label: "SMTP" }, { value: "api", label: "API" }]);
    const values = { host: "", port: 587, tls: false, kind: "", note: "" };
    expect(formReady(fields, values)).toBe(false);
    expect(formAnswer(fields, { ...values, host: "mail.example.com" })).toEqual({ action: "accept", content: { host: "mail.example.com", port: 587, tls: false } });
  });
});

describe("ввод и документ", () => {
  it("команды «/» — из списка SDK (массив, имя без слеша) плюс «/btw»; отбор по началу", () => {
    const sdk = [{ name: "compact", description: "Сжать контекст", argumentHint: "" }, { name: "review", description: "Ревью", argumentHint: "[что]" }];
    expect(commandPicks(sdk, "").map((p) => p.label)).toEqual(["/compact", "/review", "/btw"]);
    expect(commandPicks(sdk, "re")).toEqual([{ label: "/review", about: "[что] · Ревью", insert: "/review " }]);
    expect(commandPicks(undefined, "b").map((p) => p.label)).toEqual(["/btw"]);
    expect(sideQuestion("/btw  а тесты зелёные?")).toBe("а тесты зелёные?");
    expect(sideQuestion("/btw")).toBeNull();
    expect(sideQuestion("обычный текст")).toBeNull();
  });
  it("черновик живёт на каждую сессию", () => {
    draft.set("site@laptop", "не забыть подвал");
    expect(draft.get("site@laptop")).toBe("не забыть подвал");
    expect(draft.get("docs@laptop")).toBe("");
    draft.set("site@laptop", "");
    expect(draft.get("site@laptop")).toBe("");
  });
  it("действующая модель: из документа, иначе та, на которой идёт разговор, иначе первая в списке SDK", () => {
    const options = modelOptions([{ value: "claude-fable-5-2", displayName: "Fable 5.2", supportedEffortLevels: ["low", "high"], supportsFastMode: true }, { value: "claude-sonnet-5-5", displayName: "Sonnet 5.5" }]);
    expect(options[0]).toEqual({ value: "claude-fable-5-2", label: "Fable 5.2", efforts: ["low", "high"], fast: true });
    expect(effectiveModel({ model: "claude-sonnet-5-5" }, options).label).toBe("Sonnet 5.5");
    expect(effectiveModel({}, options, "claude-sonnet-5-5[1m]").label).toBe("Sonnet 5.5");
    expect(effectiveModel({}, options).label).toBe("Fable 5.2");
    expect(effectiveModel({ model: "glm-abliterated" }, options)).toEqual({ value: "glm-abliterated", label: "glm-abliterated" });
    // сессия не ответила — общий список страницы
    expect(modelOptions(undefined).length).toBeGreaterThan(2);
  });
  it("пометка «после хода»: новое добавляется, применённое сразу снимается", () => {
    expect(mergeLater([], ["mode"], ["model"])).toEqual(["model"]);
    expect(mergeLater(["model", "effort"], ["effort"], ["pieces"])).toEqual(["model", "pieces"]);
  });
});

describe("новая сессия", () => {
  const row = (callsign: string, cwd: string, pieces: string[], last: number): SessionRow => ({ callsign, state: "idle", by: "~a@b.c", since: 1, last, spec: { name: callsign.split("@")[0], cwd, pieces } });
  it("имя из папки и свободный номер; путь делится на родителя и имя", () => {
    expect(nameOf("~/projects/My Site")).toBe("my-site");
    expect(freeName("site", "laptop", { "site@laptop": 1, "site-2@laptop": 1 })).toBe("site-3");
    expect(splitPath("~/projects/si")).toEqual({ parent: "~/projects", leaf: "si" });
    expect(splitPath("C:\\work\\site")).toEqual({ parent: "C:\\work", leaf: "site" });
  });
  it("машины: на связи раньше, свои раньше чужих", () => {
    const m = (name: string, online: boolean, owner: string): MachineRow => ({ name, online, owner, since: 1 });
    expect(sortMachines([m("base2", false, "~me@x.y"), m("anya-pc", true, "~anya@x.y"), m("server", true, "~me@x.y")], "~me@x.y").map((x) => x.name)).toEqual(["server", "anya-pc", "base2"]);
  });
  it("недавние места — пары «машина + папка» без повторов; кусочки — как у соседней сессии той же папки", () => {
    const a = { machine: "laptop", cwd: "~/p/site" }, b = { machine: "server", cwd: "~/p/site" };
    expect(pushPlace([a, b], b)).toEqual([b, a]);
    const sessions = { "site@laptop": row("site@laptop", "~/p/site", ["base", "web"], 5), "old@laptop": row("old@laptop", "~/p/site", ["base"], 2), "x@server": row("x@server", "~/p/site", ["ops"], 9) };
    expect(piecesFor(sessions, "laptop", "~/p/site")).toEqual(["base", "web"]);
    expect(piecesFor(sessions, "laptop", "~/p/other")).toEqual([]);
  });
});

describe("мок отвечает в формах Host", () => {
  it("лента: сообщение занятой сессии — событие с номером и отправителем и статус «в очереди»; отмена — статус «отменено»; в разговор оно не попало", async () => {
    const m = quiet();
    const api = createApi(m.transport);
    const seen: Frame[] = [];
    m.transport.open("watch", { machine: "laptop", onFrame: (f) => seen.push(f) });
    const w = await api.call(sessionWatch, { to: "site@laptop" });
    const before = (await api.call(sessionHistory, { to: "site@laptop" })).events.length;
    const r = await api.call(message, { to: "site@laptop", text: "И подвал" });
    expect(r).toMatchObject({ queued: true });
    const events = seen.flatMap((f) => f.events as any[]);
    expect(events[0]).toMatchObject({ type: "user", uuid: r.uuid, from: "pult~yuri@example.com" });
    // живое событие мечено временем машины
    expect(events[1]).toEqual({ type: "message.status", uuid: r.uuid, status: "queued", at: expect.any(Number) });
    expect(seen.at(-1)!.seq).toBe(w.seq + 2);
    expect((await api.call(sessionWatch, { to: "site@laptop" })).queued).toMatchObject([{ uuid: r.uuid, text: "И подвал" }]);
    await expect(api.call(messageCancel, { to: "site@laptop", uuid: r.uuid! })).resolves.toEqual({ cancelled: true });
    expect(seen.flatMap((f) => f.events as any[]).at(-1)).toEqual({ type: "message.status", uuid: r.uuid, status: "cancelled", at: expect.any(Number) });
    expect((await api.call(sessionHistory, { to: "site@laptop" })).events.length).toBe(before);
  });
  it("дочитка: after — пропущенное событиями; слишком давно — gap", async () => {
    const m = quiet();
    const api = createApi(m.transport);
    const w = await api.call(sessionWatch, { to: "ingest@server" });
    m.tick();
    m.tick();
    const again = await api.call(sessionWatch, { to: "ingest@server", after: w.seq });
    expect(again.seq).toBe(w.seq + 2);
    expect(again.events).toHaveLength(2);
    expect(await api.call(sessionWatch, { to: "ingest@server", after: again.seq })).toEqual({ seq: again.seq });
    for (let i = 0; i < 260; i++) await api.call(message, { to: "site@laptop", text: "ещё " + i });
    expect((await api.call(sessionWatch, { to: "site@laptop", after: 0 })).gap).toBe(true);
  });
  it("документ: посреди хода модель применится после хода, проект — сразу; пара открывает ведомого и снимается", async () => {
    const m = quiet();
    const api = createApi(m.transport);
    expect(await api.call(sessionUpdate, { to: "site@laptop", patch: { model: "claude-sonnet-5-5", project: "infra" } })).toMatchObject({ now: ["project"], later: ["model"] });
    expect(await api.call(sessionUpdate, { to: "docs@laptop", patch: { model: "claude-sonnet-5-5" } })).toMatchObject({ now: ["model"], later: [] });
    const opened = await api.call(sessionOpen, { to: "@laptop", spec: { name: "duo", cwd: "~/projects/duo" }, pair: true, mkdir: true });
    expect(opened).toEqual({ callsign: "duo@laptop", wing: "duo-wing@laptop" });
    expect(m.state.sessions["duo-wing@laptop"]).toMatchObject({ lead: "duo@laptop", by: "duo@laptop" });
    await api.call(sessionUpdate, { to: "duo@laptop", patch: { wing: null } });
    expect(m.state.sessions["duo@laptop"].spec.wing).toBeUndefined();
    expect(m.state.sessions["duo-wing@laptop"].lead).toBeUndefined();
    await expect(api.call(sessionOpen, { to: "@laptop", spec: { name: "x", cwd: "~/projects/nope" } })).rejects.toMatchObject({ word: "bad_input" });
  });
  it("проход к SDK: команды и модели — массивы SDK; откат файлов требует сообщение и с пробой только считает", async () => {
    const m = quiet();
    const api = createApi(m.transport);
    const call = (method: any, args?: unknown) => api.call(sessionCall, { to: "site@laptop", method, args });
    expect((await call("commands") as any[])[0]).toMatchObject({ name: "compact", description: "Сжать контекст" });
    expect((await call("models") as any[])[0]).toMatchObject({ value: "claude-fable-5-2", displayName: "Fable 5.2" });
    expect(await call("contextUsage")).toMatchObject({ maxTokens: 200_000, categories: expect.any(Array) });
    expect((await call("mcpStatus") as any[]).map((s) => s.status)).toEqual(["connected", "connected", "needs-auth", "failed"]);
    await call("mcpToggle", ["playwright", false]);
    expect((await call("mcpStatus") as any[])[1]).toEqual({ name: "playwright", status: "disabled" });
    expect(await call("sideQuestion", ["а тесты?"])).toMatchObject({ response: expect.stringContaining("а тесты?") });
  });
});

describe("слияние ленты", () => {
  it("статус сообщения не теряется как повтор его номера; тот же статус дважды — один раз", () => {
    const base = [say("m1", "И подвал")];
    const st = { type: "message.status", uuid: "m1", status: "queued" };
    const merged = mergeEvents(base, [st]);
    expect(merged).toHaveLength(2);
    expect(mergeEvents(merged, [st])).toBe(merged);
    expect(mergeEvents(merged, [{ type: "message.status", uuid: "m1", status: "taken" }])).toHaveLength(3);
  });
});
