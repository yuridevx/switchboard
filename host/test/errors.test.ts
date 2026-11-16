// Эталоны машины дизайна «Ошибки на виду»: беда сессии — строка журнала машины с причиной, и она уходит в ленту сессии.
// Источник свойства — над каждым эталоном.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { TROUBLE_SAMPLES } from "@sb/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { Module } from "../src/core/contract.ts";
import { make as chat } from "../src/modules/chat/chat.ts";
import { make as machine } from "../src/modules/machine/machine.ts";
import { kindOf, named, troubles } from "../src/modules/machine/troubles.ts";
import { toMetaRequest } from "../src/modules/proxy/muse/request.ts";
import { stand, tick, until, type Stand } from "../stand/index.ts";

let st: Stand | undefined;
afterEach(async () => {
  await st?.stop();
  st = undefined;
});

const CS = "site@laptop";
const PULT = "pult~yuri@example.com";
const REFUSED = "вызов модели отклонён (400): Meta rejected the request: Missing 'impossible'.";
/** События ленты, ушедшие зрителям. */
const feed = () => st!.link.of("session.events").flatMap((f) => f.events as Array<Record<string, any>>);
const logs = () => feed().filter((e) => e.type === "log");
const journal = (msg: string) => st!.journal().filter((l) => l.msg === msg) as any[];
const say = (uuid: string, text: string) => ({ type: "assistant", uuid, message: { content: [{ type: "text", text }] } });

describe("беда сессии — в её ленту", () => {
  // чьё: слово пользователя 16 нояб. — «показ ошибок пользователю вместо скрытия»
  it("строка о сессии — в её ленту: warn о живой сессии — одно событие log с причиной; info, строка без сессии и строка о чужом имени — ни одного", async () => {
    st = await stand({ modules: [chat(), machine()] });
    await st.open("site");
    await st.request("session.watch", { to: CS }, PULT);
    st.kernel.log.info("route", { callsign: CS, why: "новая сессия" });
    st.kernel.log.error("link_stopped", { why: "строка не о сессии" });
    st.kernel.log.warn("call", { callsign: "ghost@laptop", why: "такой сессии нет" });
    st.kernel.log.warn("call", { callsign: CS, status: 400, why: REFUSED });
    await until(() => logs().length, 5000, "событие log в ленте");
    await tick(20);
    expect(logs()).toEqual([{ type: "log", uuid: expect.any(String), level: "warn", msg: "call", why: REFUSED, at: expect.any(Number) }]);
    // журнал — тот же: строка в ленте ничего в нём не меняет
    expect(journal("call").map((l) => l.callsign)).toEqual(["ghost@laptop", CS]);
  });

  // чьё: слово пользователя 16 нояб. — «показ ошибок пользователю вместо скрытия»: строка не пропадает с перезагрузкой страницы
  it("после перезагрузки строка на месте: в истории она стоит за той же записью разговора, что и при показе, и это то же событие", async () => {
    st = await stand({ modules: [chat(), machine()] });
    const { proc } = await st.open("site");
    await st.request("session.watch", { to: CS }, PULT);
    proc.send(say("a1", "Сверил: 260 адресов."));
    await until(() => feed().some((e) => e.uuid === "a1"), 5000, "ответ в ленте");
    st.kernel.log.warn("call", { callsign: CS, status: 400, why: REFUSED });
    proc.send(say("a2", "Продолжаю."));
    await until(() => feed().some((e) => e.uuid === "a2"), 5000, "второй ответ в ленте");
    const live = feed().filter((e) => e.type === "log" || e.type === "assistant");
    expect(live.map((e) => e.uuid ?? e.type)).toEqual(["a1", logs()[0]!.uuid, "a2"]);
    // файл разговора строки не хранит: её отдаёт лента, за записью a1
    const said = [say("a1", "Сверил: 260 адресов."), say("a2", "Продолжаю.")];
    (st.sdk as any).functions = new Proxy({}, { get: (_t, name) => async () => (name === "getSessionMessages" ? said : {}) });
    const before = ((await st.request("session.history", { to: CS })).result as any).events as any[];
    expect(before.map((e) => e.uuid)).toEqual(["a1", logs()[0]!.uuid, "a2"]);
    expect(before[1]).toEqual(logs()[0]);
  });

  // чьё: слово пользователя 16 нояб.; место строки после подмены Host — решение слепого архитектора (лента хранит строку за записью разговора)
  it("Host поднялся заново и записей разговора ещё не видел: строка встаёт за той же записью, что последнее сохранённое событие, а не в начало разговора", async () => {
    st = await stand({ modules: [chat(), machine()] });
    const { proc } = await st.open("site");
    proc.send(say("a1", "Сверил."));
    await tick(10);
    st.kernel.log.warn("call", { callsign: CS, why: REFUSED });
    const home = st.home, holders = st.holders;
    await st.kernel.shutdown("подмена");
    st = await stand({ modules: [chat(), machine()], home, holders });
    await until(() => st!.kernel.sessions.get(CS)?.state === "idle", 5000, "сессия поднялась");
    st.kernel.log.error("model_drift", { callsign: CS, why: "в документе одна модель, ответила другая" });
    const said = [say("a0", "Начало."), say("a1", "Сверил.")];
    (st.sdk as any).functions = new Proxy({}, { get: (_t, name) => async () => (name === "getSessionMessages" ? said : {}) });
    const h = ((await st.request("session.history", { to: CS })).result as any).events as any[];
    expect(h.map((e) => e.msg ?? e.uuid)).toEqual(["a0", "a1", "call", "model_drift"]);
  });

  // чьё: решение слепого архитектора — «журнал → ядро → модули → журнал не замыкается»
  it("сбой модуля при показе строки — только строка журнала: второго события в ленте нет, круга нет", async () => {
    let seen = 0;
    const broken: Module = { name: "host-broken", on: { event: (_s, m) => { if (m?.type === "log") { seen++; throw new Error("не смог показать"); } } } };
    st = await stand({ modules: [chat(), broken] });
    await st.open("site");
    await st.request("session.watch", { to: CS }, PULT);
    st.kernel.log.warn("call", { callsign: CS, why: REFUSED });
    await until(() => logs().length, 5000, "событие log в ленте");
    await tick(20);
    expect([seen, logs().length]).toEqual([1, 1]);
    expect(st.journal().filter((l) => l.word === "module_failed")).toMatchObject([{ level: "error", module: "host-broken", callsign: CS, why: "не смог показать" }]);
  });
});

describe("беды Claude — одна таблица на машине", () => {
  // чьё: факт — опыт 16 нояб. на SDK 0.3.321: сбой проверки цели приходит уведомлением без причины, страница его не знала
  it("каждое сообщение Claude названо: у каждого вида сообщения закреплённой версии SDK есть место — беда с уровнем или «не беда»; неназванных 0", () => {
    const types = readFileSync(join(dirname(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk")), "sdk.d.ts"), "utf8");
    const union = /export declare type SDKMessage = ([^;]+);/.exec(types)![1]!.split("|").map((x) => x.trim());
    /** Тело объявления типа и типов, из которых он собран объединением. */
    const kinds = (name: string): string[] => {
      const alias = new RegExp(`export declare type ${name} = ((?:SDK\\w+\\s*\\|\\s*)+SDK\\w+);`).exec(types);
      if (alias) return alias[1]!.split("|").flatMap((x) => kinds(x.trim()));
      const body = new RegExp(`export declare type ${name} = \\{([\\s\\S]*?)\\n\\};`).exec(types)?.[1] ?? "";
      const type = /\n {4}type: '([a-z_]+)'/.exec(body)?.[1];
      const subtype = /\n {4}subtype: '([a-z_]+)'/.exec(body)?.[1];
      return type ? [type === "system" ? `system:${subtype}` : type] : [];
    };
    const all = [...new Set(union.flatMap(kinds))];
    // сам разбор объявлений не пуст: в объединении 40 типов сообщений
    expect(union.length).toBeGreaterThanOrEqual(40);
    expect(all.length).toBeGreaterThanOrEqual(35);
    expect(all.filter((k) => !named(k))).toEqual([]);
  });

  // чьё: слово пользователя 16 нояб. — гейт архитектора: одно правило считается в одном месте (уровень и слова беды — у машины)
  it("образцы бед: машина даёт каждому строку своего уровня с причиной; warn и error названы словами, а не видом сообщения", () => {
    for (const s of TROUBLE_SAMPLES) {
      const lines = troubles(s.event);
      expect([s.name, lines.map((l) => l.level)]).toEqual([s.name, [s.level]]);
      expect(lines[0]!.why.length).toBeGreaterThan(5);
      expect(named(kindOf(s.event))).toBe(true);
    }
    const why = (name: string) => troubles(TROUBLE_SAMPLES.find((s) => s.name === name)!.event)[0]!.why;
    expect(why("ход остановлен")).toBe("ход остановлен: API Error: Request rejected (429) · Subscription quota exhausted.");
    expect(why("лимит аккаунта")).toBe("лимит аккаунта (неделя): отказ до 2026-11-19 21:00 UTC");
    expect(why("сервер инструментов не поднялся")).toBe("серверы инструментов не поднялись: ida");
    expect(why("записи разговора потеряны")).toBe("записи потеряны — диск полон: не сохранено часть разговора");
    expect(why("хук не сработал")).toBe("хук PreToolUse:Bash не сработал (код 2): lint failed");
    expect(why("важное уведомление Claude")).toBe("Stop hook error occurred · ctrl+o to see");
    // обычный ход и обычные сообщения — не беда
    expect(troubles({ type: "result", subtype: "success", is_error: false, result: "готово" })).toEqual([]);
    expect(troubles({ type: "system", subtype: "notification", text: "к сведению", priority: "low" })).toEqual([]);
    expect(troubles({ type: "system", subtype: "hook_response", hook_name: "Stop", outcome: "success", exit_code: 0 })).toEqual([]);
  });

  // чьё: код — так страница делала до дизайна (прерванный ход строки ошибки не давал); признак — факт: опыт 16 нояб., итог несёт terminal_reason aborted_streaming
  it("прерванный ход — не беда: строка журнала уровня info, в ленте строк беды 0", async () => {
    st = await stand({ modules: [chat(), machine()] });
    const { proc } = await st.open("site");
    await st.request("session.watch", { to: CS }, PULT);
    proc.send({ type: "system", subtype: "session_state_changed", state: "running" });
    await until(() => st!.kernel.sessions.get(CS)!.state === "busy", 5000, "ход идёт");
    await st.request("session.call", { to: CS, method: "interrupt" }, PULT);
    await until(() => feed().some((e) => e.type === "result"), 5000, "итог хода в ленте");
    await tick(20);
    expect(journal("sdk.result")).toMatchObject([{ callsign: CS, level: "info", word: "interrupted" }]);
    expect(logs()).toEqual([]);
  });

  // чьё: слово пользователя 16 нояб. — «показ ошибок вместо скрытия»: сбой, о котором говорит Claude, человек видит в ленте с причиной
  it("ход оборвался и сервер инструментов не поднялся: строки error в журнале и по событию log на каждую в ленте; init второго хода строки не повторяет", async () => {
    st = await stand({ modules: [chat(), machine()] });
    const { proc } = await st.open("site");
    await st.request("session.watch", { to: CS }, PULT);
    const init = { type: "system", subtype: "init", model: "m", claude_code_version: "2.1.321", cwd: "/w", permissionMode: "bypassPermissions", mcp_servers: [{ name: "ida", status: "failed" }] };
    proc.send(init);
    proc.send({ type: "result", subtype: "success", is_error: true, result: "API Error: Request rejected (429) · Subscription quota exhausted." });
    proc.send(init);
    await until(() => logs().length === 2, 5000, "две строки беды в ленте");
    await tick(20);
    expect(logs().map((e) => [e.level, e.msg, e.why])).toEqual([
      ["error", "sdk.init", "серверы инструментов не поднялись: ida"],
      ["error", "sdk.result", "ход остановлен: API Error: Request rejected (429) · Subscription quota exhausted."],
    ]);
  });
});

describe("схема ответа для Meta", () => {
  const format = (schema: unknown) => toMetaRequest({ model: "muse-spark-1.3", max_tokens: 64, messages: [{ role: "user", content: "ok" }], output_config: { format: { type: "json_schema", schema } } }).body.text.format;

  // чьё: факт — случай 16 нояб.: Meta отклонила 7 проверок цели из 7 — «'required' … Missing 'impossible'»
  it("схема с необязательным полем уходит нестрогой; схема, где required называет каждое поле на всех уровнях, — строгой", () => {
    const goal = { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" }, reason: { type: "string" }, impossible: { type: "boolean" } }, required: ["ok", "reason"] };
    expect(format(goal)).toMatchObject({ type: "json_schema", strict: false, schema: goal });
    expect(format({ ...goal, required: ["ok", "reason", "impossible"] }).strict).toBe(true);
    const nested = { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", items: { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" }, b: { type: "string" } } } } } };
    expect(format(nested).strict).toBe(false);
    expect(format({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }).strict).toBe(false);
  });
});
