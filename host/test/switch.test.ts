// Эталоны машины дизайна «Свободная смена модели»: смена на лету, окно, имена, сверка, путь OpenAI-протокола.
// Провайдеры на стенде — один локальный сервер: помнит каждый вызов. Источник свойства — над каждым эталоном; номер — номер эталона дизайна.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Module } from "../src/core/contract.ts";
import { make as accounts } from "../src/modules/accounts/accounts.ts";
import { capOf, procModel } from "../src/modules/accounts/pair.ts";
import { encodeSignature, toMetaRequest } from "../src/modules/proxy/muse/request.ts";
import { make as proxy } from "../src/modules/proxy/proxy.ts";
import { stand, tick, until, type Stand } from "../stand/index.ts";

let st: Stand | undefined;
const servers: Server[] = [];
afterEach(async () => {
  await st?.stop();
  st = undefined;
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

const A = "a@example.com";
const CS = "site@laptop";
const T0 = Date.UTC(2026, 9, 30, 14, 0, 0);
const FABLE = "claude-fable-5-2", OPUS = "claude-opus-4-8", HAIKU = "claude-haiku-4-5";
const CATALOGS: Record<string, Array<Record<string, unknown>>> = {
  claude: [{ id: FABLE, window: 1_000_000 }, { id: OPUS, window: 1_000_000 }, { id: HAIKU, window: 200_000 }],
  // провайдер Anthropic-протокола: окна 256 К, 200 К и имя с «[1m]» в самом каталоге
  orca: [{ id: "qwen-3.5-coder", window: 256_000 }, { id: "glm-5.3", window: 200_000 }, { id: "big[1m]", window: 1_048_576 }],
  // провайдер OpenAI-протокола
  oai: [{ id: "grok-4.5", window: 200_000, protocol: "openai" }, { id: "grok-5", window: 200_000, protocol: "openai" }],
  // ключ со своим окружением сессии
  enved: [{ id: "m1", window: 200_000 }],
};

type Hit = { path: string; model: string; headers: IncomingHttpHeaders; body: any };
type Reply = { status?: number; body?: unknown };
const raised: Array<{ kind: string; key: string }> = [];
const incidents = (): Module => ({ name: "host-incidents", requests: { "incident.raise": (i: { kind: string; key: string }) => (raised.push(i), { id: String(raised.length) }) } });

/** Флот на стенде: аккаунт Claude и три провайдера на одном поддельном сервере. */
async function fleet(answer: (hit: Hit) => Reply = () => ({}), o: { home?: string; holders?: Stand["holders"] } = {}) {
  raised.length = 0;
  const hits: Hit[] = [];
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const hit = { path: req.url ?? "", model: body.model as string, headers: req.headers, body };
      hits.push(hit);
      const a = answer(hit);
      res.writeHead(a.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(a.body ?? { type: a.status && a.status >= 400 ? "error" : "message", error: { message: "отказ провайдера" } }));
    });
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const home = o.home ?? mkdtempSync(join(tmpdir(), "sb2-host-"));
  if (!o.home) {
    mkdirSync(join(home, "store"), { recursive: true });
    writeFileSync(join(home, "store", "host-accounts.json"), JSON.stringify({ machine: { accounts: { [A]: { ok: true, keep: false, limits: {} } } } }));
  }
  st = await stand({ home, ...(o.holders ? { holders: o.holders } : {}), modules: [accounts(), proxy(), incidents()], config: { "host-accounts": { api: url } }, start: false });
  const KEYS: Record<string, Record<string, unknown>> = { orca: { protocol: "anthropic" }, oai: { protocol: "openai" }, enved: { protocol: "anthropic", env: { PROVIDER_REGION: "eu" } } };
  st.services.handlers["keys.list"] = () => ({ keys: [{ name: A, protocol: "claude", at: 1, tail: "tail" }, ...Object.entries(KEYS).map(([name, k]) => ({ name, at: 1, tail: "tail", base: url, ...k }))] });
  st.services.handlers["keys.value"] = (f: any) => (KEYS[f.name] ? { value: `sk-${f.name}`, base: url, ...KEYS[f.name] } : { value: `tok-${f.name}`, protocol: "claude" });
  st.services.handlers["keys.models"] = (f: any) => ({ models: CATALOGS[f.name] ?? [] });
  st.services.handlers["prefs.get"] = () => ({ values: { "proxy.rules": [] } });
  await st.kernel.start();
  return { url, hits, home };
}
const row = () => st!.link.rows(CS).at(-1)!.row as any;
const journal = (msg: string) => st!.journal().filter((l) => l.msg === msg) as any[];
const update = (patch: Record<string, unknown>) => st!.request("session.update", { to: CS, patch });
const swaps = (q: { calls: Array<{ name: string; args: unknown[] }> }) => q.calls.filter((c) => c.name === "setModel").map((c) => c.args[0]);
/** Вызов модели от процесса сессии через прокси машины. */
const call = (sid: string, model: string, extra: Record<string, unknown> = {}) => {
  const base = (st!.sdk.queries.at(-1)!.options as any).env.ANTHROPIC_BASE_URL as string;
  return fetch(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fleet", "x-claude-code-session-id": sid }, body: JSON.stringify({ model, messages: [{ role: "user", content: "привет" }], ...extra }) });
};
const said = (model: string) => ({ type: "assistant", uuid: `u-${model}-${Math.random()}`, parent_tool_use_id: null, message: { model, content: [{ type: "text", text: "ок" }] } });
const busy = async (s: { state: string }) => {
  st!.proc(CS).send({ type: "system", subtype: "session_state_changed", state: "running", session_id: "s" });
  await until(() => s.state === "busy", 5000, "busy");
};

describe("смена на лету", () => {
  // эталоны 1 и 22 — чьё: слово пользователя 17 нояб. — «свободно переключать любые модели, с Claude на другие провайдеры»; «hot reload, а не полную перегрузку»
  it("1 · сессия свободна, Claude → модель OpenAI-протокола: документ записан, живой процесс переключён командой, первый вызов — новому провайдеру, перезапуска нет; 22 · строка журнала о смене", async () => {
    const api = await fleet();
    const { s, q } = await st!.open("site", { key: "claude", model: FABLE });
    expect([(q.options as any).model, (q.options as any).env.CLAUDE_CODE_OAUTH_TOKEN]).toEqual([`${FABLE}[1m]`, "fleet"]);
    const queries = st!.sdk.queries.length;
    expect(await update({ key: "oai", model: "grok-4.5" })).toMatchObject({ ok: true, result: { now: ["model", "key"], later: [] } });
    expect(s.rec.spec).toMatchObject({ key: "oai", model: "grok-4.5" });
    expect(swaps(q)).toEqual(["grok-4.5"]);
    expect([st!.sdk.queries.length, s.restarts]).toEqual([queries, 0]);
    await call(s.rec.sessionId, "grok-4.5");
    expect(api.hits.map((h) => [h.path, h.headers.authorization, h.model])).toEqual([["/v1/responses", "Bearer sk-oai", "grok-4.5"]]);
    expect(journal("model_switch")).toMatchObject([{ callsign: CS, from: `claude/${FABLE}`, to: "oai/grok-4.5", protocol: "openai", how: "hot" }]);
    expect(typeof journal("model_switch")[0].ms).toBe("number");
  });

  // эталон 2 — чьё: факт опыта 17 нояб. — посреди хода ход закончила новая модель; ложная тревога «ответила не та» у прежнего устройства
  it("2 · смена посреди хода: команда уходит сразу; ответ прежней модели до конца хода — не тревога; в следующем ходе сверка работает", async () => {
    await fleet();
    const { s, q } = await st!.open("site", { key: "claude", model: FABLE });
    await busy(s);
    expect(await update({ key: "claude", model: OPUS })).toMatchObject({ ok: true });
    expect(swaps(q)).toEqual([`${OPUS}[1m]`]);
    st!.proc(CS).send(said(FABLE));
    st!.proc(CS).send({ type: "result", subtype: "success", result: "готово", session_id: "s" });
    st!.proc(CS).send({ type: "system", subtype: "session_state_changed", state: "idle", session_id: "s" });
    await until(() => s.state === "idle", 5000, "idle");
    expect(row().answers).toBeUndefined();
    expect(journal("model_drift")).toHaveLength(0);
    await st!.turn(CS, [said(FABLE)]);
    expect(row().answers).toBe(FABLE);
    expect(journal("model_drift")).toHaveLength(1);
  });

  // эталон 3 — чьё: код
  it("3 · та же пара, что уже в документе: ни команды, ни перезапуска", async () => {
    await fleet();
    const { s, q } = await st!.open("site", { key: "claude", model: FABLE });
    expect(await update({ key: "claude", model: FABLE })).toMatchObject({ ok: true, result: { later: [] } });
    expect([swaps(q), s.restarts, journal("model_switch")]).toEqual([[], 0, []]);
  });

  // эталон 4 — чьё: факт опыта 17 нояб. — с провайдера, отвечающего 400 и 503, уйти было нельзя: 2 из 2
  it("4 · прежний провайдер отвечает 503: смена принята, обращений к прежнему 0", async () => {
    const api = await fleet((hit) => (hit.headers.authorization === `Bearer tok-${A}` ? { status: 503 } : {}));
    const { s } = await st!.open("site", { key: "claude", model: FABLE });
    expect((await call(s.rec.sessionId, FABLE)).status).toBe(503);
    api.hits.length = 0;
    expect(await update({ key: "orca", model: "glm-5.3" })).toMatchObject({ ok: true });
    expect(api.hits).toHaveLength(0);
    expect((await call(s.rec.sessionId, "glm-5.3")).status).toBe(200);
    expect(api.hits.map((h) => [h.headers["x-api-key"], h.model])).toEqual([["sk-orca", "glm-5.3"]]);
  });

  // эталон 5 — чьё: слово пользователя 15 нояб. — «выбранная не точно работает»; решение дизайна: отказ словами провайдера, документ назад
  it("5 · новый провайдер отклонил пробу: отказ его словами, документ и маршрут — на прежней паре", async () => {
    const api = await fleet();
    const { s, q } = await st!.open("site", { key: "claude", model: FABLE });
    (q as any).setModel = async () => {
      throw new Error("API error: 503 The upstream provider is temporarily unavailable · model not changed");
    };
    const r = await update({ key: "oai", model: "grok-4.5" });
    expect(r).toMatchObject({ ok: false, error: "model_refused" });
    expect(r.why).toContain("oai/grok-4.5");
    expect(r.why).toContain("temporarily unavailable");
    expect(s.rec.spec).toMatchObject({ key: "claude", model: FABLE });
    expect(row().spec).toMatchObject({ key: "claude", model: FABLE });
    await call(s.rec.sessionId, FABLE);
    expect(api.hits.map((h) => [h.path, h.headers.authorization])).toEqual([["/v1/messages", `Bearer tok-${A}`]]);
    expect(journal("model_switch")).toHaveLength(0);
  });

  // эталон 6 — чьё: слово пользователя 15 нояб. — «не могу выбрать нужную»
  it("6 · модели нет в каталоге: отказ словом с похожими именами, документ и процесс прежние", async () => {
    await fleet();
    const { s, q } = await st!.open("site", { key: "claude", model: FABLE });
    const r = await update({ key: "oai", model: "grok-4" });
    expect(r).toMatchObject({ ok: false, error: "no_model" });
    expect(r.why).toContain("grok-4.5");
    expect([s.rec.spec.key, swaps(q)]).toEqual(["claude", []]);
  });

  // эталон 7 — чьё: код
  it("7 · сессия остановлена: документ записан, запуск поднимает процесс с новой парой", async () => {
    await fleet();
    const { s, q } = await st!.open("site", { key: "claude", model: FABLE });
    await st!.request("session.stop", { to: CS });
    expect(await update({ key: "oai", model: "grok-4.5" })).toMatchObject({ ok: true });
    expect(swaps(q)).toEqual([]);
    await st!.request("session.start", { to: CS });
    await until(() => s.state === "idle", 5000, "idle");
    const o = st!.sdk.queries.at(-1)!.options as any;
    expect([o.model, o.env.CLAUDE_CODE_OAUTH_TOKEN, o.env.ANTHROPIC_API_KEY]).toEqual(["grok-4.5", "fleet", undefined]);
  });

  // эталоны 8 и 23 — чьё: факт опыта 17 нояб. — точный предел окна задаётся только при запуске; правка слепого архитектора — правило в обе стороны
  it("8 · модели нужен точный предел окна или у ключа своё окружение: смена сразу, после хода — перезапуск с новым окружением; 23 · обратно — перезапуск снимает их", async () => {
    await fleet();
    const { s, q } = await st!.open("site", { key: "claude", model: FABLE });
    const launched = () => st!.sdk.queries.at(-1)!.options as any;
    // на модель с окном 256 К: имя с «[1m]» сразу, предел — перезапуском
    expect(await update({ key: "orca", model: "qwen-3.5-coder" })).toMatchObject({ ok: true, result: { now: [], later: ["model", "key"] } });
    expect(swaps(q)).toEqual(["qwen-3.5-coder[1m]"]);
    await until(() => launched().env.CLAUDE_CODE_AUTO_COMPACT_WINDOW === "256000" && s.state === "idle", 5000, "перезапуск с пределом");
    expect([launched().model, launched().resume]).toEqual(["qwen-3.5-coder[1m]", s.rec.sessionId]);
    expect(journal("model_switch").at(-1)).toMatchObject({ how: "restart" });
    // обратно на модель без предела: предел прежней пары снят перезапуском
    expect(await update({ key: "orca", model: "glm-5.3" })).toMatchObject({ ok: true, result: { later: ["model", "key"] } });
    await until(() => launched().env.CLAUDE_CODE_AUTO_COMPACT_WINDOW === undefined && launched().model === "glm-5.3" && s.state === "idle", 5000, "перезапуск без предела");
    // на ключ со своим окружением и обратно
    expect(await update({ key: "enved", model: "m1" })).toMatchObject({ ok: true, result: { later: ["model", "key"] } });
    await until(() => launched().env.PROVIDER_REGION === "eu" && s.state === "idle", 5000, "перезапуск с окружением ключа");
    expect(await update({ key: "orca", model: "glm-5.3" })).toMatchObject({ ok: true, result: { later: ["model", "key"] } });
    await until(() => launched().env.PROVIDER_REGION === undefined && s.state === "idle", 5000, "перезапуск без окружения ключа");
  });

  // эталон 9 — устав: после перезапуска Host модуль поднимает своё из хранилища
  it("9 · программа машины подменена после смены: процесс тот же, вызовы идут паре документа", async () => {
    const api = await fleet();
    const { s } = await st!.open("site", { key: "claude", model: FABLE });
    expect(await update({ key: "orca", model: "glm-5.3" })).toMatchObject({ ok: true });
    const sid = s.rec.sessionId, holders = st!.holders;
    expect(JSON.parse(readFileSync(join(api.home, "store", "host-accounts.json"), "utf8")).sessions[CS].pair).toMatchObject({ key: "orca", model: "glm-5.3", protocol: "anthropic" });
    await st!.kernel.shutdown("подмена");
    api.hits.length = 0;
    // запись о паре пережила подмену: адрес и ключ провайдера — из неё, каталог заново не читается
    await fleet(() => ({}), { home: api.home, holders });
    await until(() => st!.kernel.sessions.get(CS)?.state === "idle", 5000, "idle после подмены");
    expect(st!.kernel.sessions.get(CS)!.launched).toBe("attach");
    const base = `http://127.0.0.1:${JSON.parse(readFileSync(join(api.home, "store", "host-proxy.json"), "utf8")).machine.port}`;
    await fetch(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-claude-code-session-id": sid }, body: JSON.stringify({ model: "glm-5.3", messages: [] }) });
    expect(api.hits.map((h) => [h.headers["x-api-key"], h.model])).toEqual([["sk-orca", "glm-5.3"]]);
    expect(st!.services.of("keys.models")).toHaveLength(0);
  });

  // эталон 24 — устав: «у всех операций должен быть лимит» (слово пользователя 2 нояб.); правка слепого архитектора
  it("24 · новый провайдер молчит: через 30 с — отказ словом, документ на прежней паре, процесс перезапущен на паре документа", async () => {
    await fleet();
    const { s, q } = await st!.open("site", { key: "claude", model: FABLE });
    (q as any).setModel = () => new Promise(() => {});
    const queries = st!.sdk.queries.length;
    const asked = update({ key: "oai", model: "grok-4.5" });
    await tick();
    st!.clock.advance(29_000);
    await tick();
    expect(s.rec.spec.key).toBe("oai");
    st!.clock.advance(1_000);
    const r = await asked;
    expect(r).toMatchObject({ ok: false, error: "model_refused" });
    expect(r.why).toContain("не ответил за 30 с");
    expect(s.rec.spec).toMatchObject({ key: "claude", model: FABLE });
    await until(() => st!.sdk.queries.length === queries + 1 && s.state === "idle", 5000, "чистый перезапуск");
    expect((st!.sdk.queries.at(-1)!.options as any).model).toBe(`${FABLE}[1m]`);
  });
});

describe("окно, имена и сверка", () => {
  // эталон 10 — чьё: факт опыта 17 нояб. — окно процесса по имени 200 К, с «[1m]» 1 М, предел 500 000 дал 500 000; слово пользователя — «правильный размер контекста и сжатия»
  it("10 · окно каталога 200 К — имя как есть; от миллиона — имя с «[1m]»; иное — имя и предел при запуске", () => {
    const of = (window?: number) => [procModel({ model: "m", window }), capOf({ window })];
    expect(of(200_000)).toEqual(["m", undefined]);
    expect(of(1_000_000)).toEqual(["m[1m]", undefined]);
    expect(of(1_048_576)).toEqual(["m[1m]", undefined]);
    expect(of(500_000)).toEqual(["m[1m]", 500_000]);
    expect(of(131_072)).toEqual(["m", 131_072]);
    expect(of(undefined)).toEqual(["m", undefined]);
  });

  // эталон 16 — чьё: факт 17 нояб. — 121 из 379 имён каталога OpenRouter кончаются на «[1m]» и не выбирались; правка слепого архитектора — имя в документе как в каталоге
  it("16 · имя с «[1m]» в каталоге стороннего провайдера: в документе и у провайдера — как в каталоге; имя для процесса суффикс не удваивает", async () => {
    const api = await fleet();
    const { s, q } = await st!.open("site", { key: "claude", model: HAIKU });
    expect((q.options as any).model).toBe(HAIKU);
    expect(await update({ key: "orca", model: "big[1m]" })).toMatchObject({ ok: true, result: { later: [] } });
    expect([s.rec.spec.model, swaps(q)]).toEqual(["big[1m]", ["big[1m]"]]);
    await call(s.rec.sessionId, "big");
    expect(api.hits.map((h) => h.model)).toEqual(["big[1m]"]);
  });

  // эталон 17 — чьё: факт опыта 17 нояб. — OpenRouter называет модель в ответе иначе: ложная тревога 3 из 3; развилка решена рекомендованным вариантом
  it("17 · ответ назвал другое имя модели: у стороннего провайдера тревоги нет", async () => {
    await fleet();
    await st!.open("site", { key: "orca", model: "glm-5.3" });
    await st!.turn(CS, [said("zhipu/glm-5.3-20261101")]);
    expect(row().answers).toBeUndefined();
    expect([journal("model_drift"), raised]).toEqual([[], []]);
  });

  // эталон 21 — чьё: код (побочные вызовы стороннего — на модель сессии); правка слепого архитектора — имя решает хозяин пары
  it("21 · вызов с именем не из документа: путь Claude — модели Claude как есть, чужое имя — модель документа", async () => {
    const api = await fleet();
    const { s } = await st!.open("site", { key: "claude", model: FABLE });
    await call(s.rec.sessionId, HAIKU);
    await call(s.rec.sessionId, "muse-spark-1.3");
    expect(api.hits.map((h) => h.model)).toEqual([HAIKU, FABLE]);
    // в строке журнала вызова — имя, которое ушло провайдеру
    expect(journal("call").map((l) => l.model)).toEqual([HAIKU, FABLE]);
  });
});

describe("путь OpenAI-протокола", () => {
  // эталоны 19 и 20 — чьё: слово пользователя 17 нояб. — матрица «Anthropic-протокол, OpenAI-протокол»; факт опыта — чужое рассуждение провайдер отклонил 1 раз из 3
  it("19 · запрос уходит на /v1/responses с ключом провайдера и без заголовков Meta; 20 · из истории уходит только рассуждение этой же модели этого провайдера", async () => {
    const api = await fleet(() => ({ status: 503, body: { error: { message: "upstream is down" } } }));
    const { s } = await st!.open("site", { key: "oai", model: "grok-4.5" });
    const own = encodeSignature({ id: "rs_own", encrypted_content: "E1" }, "oai/grok-4.5");
    const other = encodeSignature({ id: "rs_other", encrypted_content: "E2" }, "oai/grok-5");
    const r = await call(s.rec.sessionId, "grok-4.5", {
      max_tokens: 100,
      messages: [
        { role: "user", content: "раз" },
        { role: "assistant", content: [{ type: "thinking", thinking: "", signature: own }, { type: "thinking", thinking: "", signature: other }, { type: "thinking", thinking: "…", signature: "CAQS0Anthropic" }, { type: "text", text: "два" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ],
      tools: [{ name: "Bash", description: "", input_schema: { type: "object", properties: {} } }, { type: "web_search_20250305", name: "web_search" }],
    });
    expect(r.status).toBe(529);
    expect(((await r.json()) as any).error.message).toContain("upstream is down");
    const hit = api.hits[0]!;
    expect([hit.path, hit.headers.authorization, hit.headers["x-tbh-session-id"], hit.model]).toEqual(["/v1/responses", "Bearer sk-oai", undefined, "grok-4.5"]);
    expect(hit.body.input.filter((i: any) => i.type === "reasoning").map((i: any) => i.id)).toEqual(["rs_own"]);
    expect(hit.body.input.map((i: any) => i.type)).toEqual(["message", "reasoning", "message", "function_call", "function_call_output"]);
    // поиск в вебе ведёт только диалект Meta: у OpenAI-протокола инструмента нет, о пробеле — строка журнала
    expect(hit.body.tools.map((t: any) => t.name)).toEqual(["Bash"]);
    await until(() => journal("gap").length > 0, 5000, "строка о пробеле перевода");
    expect(journal("gap")[0].why).toContain("web_search");
  });

  // эталон 19, диалект — чьё: код (поиск Meta через прокси)
  it("19 · диалект Meta оставляет поиск в вебе: инструмент поиска у модели есть", () => {
    const tools = [{ type: "web_search_20250305", name: "web_search" }];
    const req = { model: "muse-spark-1.3", max_tokens: 64, messages: [{ role: "user", content: "найди" }], tools };
    expect(toMetaRequest(req, { author: "muse/muse-spark-1.3", search: true }).body.tools ?? []).toHaveLength(1);
    expect(toMetaRequest(req, { author: "oai/grok-4.5", search: false }).body.tools ?? []).toHaveLength(0);
  });
});

// T0 — начало часов стенда: названо для читателя эталонов со временем
void T0;
