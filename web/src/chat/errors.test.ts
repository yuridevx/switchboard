// Эталоны страницы дизайна «Ошибки на виду», лента: беду сессии рисует одна ветка — строка журнала машины (событие log).
// Источник свойства — над каждым эталоном.
import { TROUBLE_SAMPLES } from "@sb/protocol";
import { describe, expect, it } from "vitest";
import { exportMd, focused } from "./focus.ts";
import { fold, type Msg, type Row } from "./fold.ts";

const REFUSED = "вызов модели отклонён (400): Meta rejected the request: Missing 'impossible'.";
let n = 0;
const log = (level: "warn" | "error", msg: string, why?: string): Msg => ({ type: "log", uuid: `l${++n}`, level, msg, ...(why ? { why } : {}), at: 1794829735354 });
const reply = (uuid: string, text: string): Msg => ({ type: "assistant", uuid, message: { id: uuid, content: [{ type: "text", text }] } });
const me = (uuid: string, text: string): Msg => ({ type: "user", uuid, message: { role: "user", content: text } });
const retry = (attempt: number): Msg => ({ type: "system", subtype: "api_retry", uuid: `r${attempt}`, attempt, max_retries: 10, error_status: 400, retry_delay_ms: 2000 });
const lines = (rows: Row[]) => rows.filter((r): r is Extract<Row, { k: "line" }> => r.k === "line" && !!r.log);

describe("лента: беда сессии — строка журнала машины", () => {
  // чьё: слово пользователя 16 нояб. — «показ ошибок пользователю вместо скрытия»: новая беда видна без правки страницы
  it("лента рисует любую строку: событие с незнакомым именем — строка с причиной; без причины — имя строки журнала; warn жёлтая, error красная", () => {
    const v = fold([log("warn", "something.new", "новый вид беды: причина словами машины"), log("error", "session_failed", "второй сбой до готовности: код 1"), log("warn", "orphan_kill")]);
    expect(lines(v.rows).map((r) => [r.tone, r.text])).toEqual([
      ["wait", "новый вид беды: причина словами машины"],
      ["bad", "второй сбой до готовности: код 1"],
      ["wait", "orphan_kill"],
    ]);
  });

  // чьё: слово пользователя 16 нояб. — лента не зашумляется: 7 отказов проверки цели подряд — одна строка
  it("та же строка подряд — одна со счётом; «повтор запроса» между ними счёта не рвёт; другая строка или ответ — рвут", () => {
    const v = fold([log("warn", "call", REFUSED), retry(1), log("warn", "call", REFUSED), retry(2), log("warn", "call", REFUSED), reply("a1", "Продолжаю."), log("warn", "call", REFUSED)]);
    expect(lines(v.rows).map((r) => r.text + (r.dim ?? ""))).toEqual([`${REFUSED} ×3`, REFUSED]);
    // строка хода о повторе остаётся одна — последняя
    expect(v.rows.filter((r) => r.k === "sys" && r.retry)).toHaveLength(1);
  });

  // чьё: слово пользователя 16 нояб. — гейт архитектора: одно правило считается в одном месте (беду называет машина)
  it("беду рисует один: сообщения Claude, которые таблица машины называет бедой, страница словами не рисует — строк 0", () => {
    const named = TROUBLE_SAMPLES.filter((s) => s.level !== "info");
    expect(named.length).toBeGreaterThanOrEqual(14);
    for (const s of named) expect([s.name, fold([{ ...s.event, uuid: "u1" }]).rows]).toEqual([s.name, []]);
    // ход, прерванный человеком, строки ошибки не даёт; повтор запроса — строка хода, не беда
    const stop = TROUBLE_SAMPLES.find((s) => s.name === "ход прерван человеком")!;
    expect(fold([{ ...stop.event, uuid: "u2" }]).rows).toEqual([]);
    const again = TROUBLE_SAMPLES.find((s) => s.name === "повтор запроса")!;
    expect(fold([{ ...again.event, uuid: "u3" }]).rows).toMatchObject([{ k: "sys", retry: true }]);
  });

  // чьё: код — так лента закрывала ход и до дизайна: после итога с ошибкой новая строка «ход закончен» не встаёт
  it("ход оборвался: причина — строкой журнала, итог с ошибкой своей строки не даёт, следующий ввод «ход закончен» не ставит", () => {
    const v = fold([me("m1", "Запиши второй файл."), reply("a1", "Пишу."), { type: "result", subtype: "success", is_error: true, uuid: "e1", result: "API Error: 429" }, log("error", "sdk.result", "ход остановлен: API Error: 429"), me("m2", "Ещё раз.")]);
    expect(v.rows.map((r) => r.k)).toEqual(["me", "reply", "line", "me"]);
    // ответ без итога — ход закрывает новый ввод, как раньше
    expect(fold([me("m1", "Привет"), reply("a1", "Ответ."), me("m2", "Дальше")]).rows.map((r) => r.k)).toEqual(["me", "reply", "res", "me"]);
  });

  // чьё: слово пользователя 16 нояб. — «после перезагрузки строка на месте»: событие из истории и из живой ленты — одно
  it("та же строка из истории и из живой ленты — одна: номер события один", () => {
    const line = log("warn", "call", REFUSED);
    const v = fold([reply("a1", "Сверил."), line, reply("a2", "Дальше."), line]);
    expect(lines(v.rows)).toHaveLength(1);
    expect(v.rows.map((r) => r.k)).toEqual(["reply", "line", "reply"]);
  });

  // чьё: слово пользователя 16 нояб. — «вместо скрытия»: свёрнутый вид хода беду не прячет
  it("в фокусе и в выгрузке строка беды на виду", () => {
    const v = fold([me("m1", "Сверь."), reply("a1", "Сверил."), log("warn", "call", REFUSED), { type: "result", subtype: "success", uuid: "r1", duration_ms: 1000, num_turns: 1 }]);
    expect(focused(v).filter((r) => r.k === "line")).toMatchObject([{ text: REFUSED }]);
    expect(exportMd("site@laptop", v)).toContain(`> ⚠ ${REFUSED}`);
  });
});
