// Эталоны ядра: «ход с ответом», час кэша разговора и сжатие при простое. Источник — дизайны «Сжатие при простое» и «Аккаунты и модели».
import { afterEach, describe, expect, it } from "vitest";
import { make as chat } from "../src/modules/chat/chat.ts";
import { stand, tick, type Stand } from "../stand/index.ts";

let st: Stand | undefined;
afterEach(async () => {
  await st?.stop();
  st = undefined;
});

const CS = "site@laptop";
const MIN = 60_000;
/** Начало поддельных часов стенда. */
const T0 = Date.UTC(2026, 9, 30, 14, 0, 0);
const row = () => st!.link.rows(CS).at(-1)!.row as any;
/** Ответ модели в основном разговоре: размер разговора и срок кэша — как их называет Claude. */
const answer = (size: number, ttl: "1h" | "5m" = "1h", model = "claude-fable-5-2") => ({
  type: "assistant", uuid: `a-${size}-${Math.random()}`, parent_tool_use_id: null,
  message: { model, content: [{ type: "text", text: "готово" }], usage: { input_tokens: 2, cache_read_input_tokens: size - 6402, cache_creation_input_tokens: 6400, cache_creation: { ephemeral_1h_input_tokens: ttl === "1h" ? 6400 : 0, ephemeral_5m_input_tokens: ttl === "5m" ? 6400 : 0 } } },
});
const compacts = () => st!.proc(CS).inputs.filter((i) => i.message.content === "/compact").length;
const journal = (msg: string) => st!.journal().filter((l) => l.msg === msg);

describe("ход с ответом", () => {
  // чьё: слово пользователя 11 нояб. — ход без ответа не зовёт человека; факт опыта — итог хода «/compact» пустой
  it("ход, где модель ответила: «закончила … назад» сдвинулось, человек позван", async () => {
    st = await stand({ modules: [chat()] });
    await st.open("site");
    await st.request("message", { to: CS, text: "сделай" });
    st.clock.advance(MIN);
    await st.turn(CS, [answer(120_000)], "готово");
    expect(row().last).toBe(T0 + MIN);
    expect(st.services.of("reach.send")).toHaveLength(1);
    expect(row().unread).toEqual(["~yuri@example.com"]);
  });

  it("ход без ответа модели — сжатие: время не сдвинулось, зова нет, непрочитанного нет", async () => {
    st = await stand({ modules: [chat()] });
    await st.open("site");
    await st.request("message", { to: CS, text: "сделай" });
    await st.turn(CS, [answer(120_000)], "готово");
    const last = row().last;
    await st.request("session.read", { to: CS });
    st.clock.advance(10 * MIN);
    await st.turn(CS, [{ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 120_000, post_tokens: 9_000 } }], "");
    expect(row().last).toBe(last);
    expect(st.services.of("reach.send")).toHaveLength(1);
    expect(row().unread).toEqual([]);
  });
});

describe("час кэша в строке сессии", () => {
  // чьё: слово пользователя 15 нояб. — «время кэша сессии»; факт опыта — кэш часовой
  it("ответ записал разговор в часовой кэш, разговор 120 К: в строке час кэша — час от ответа, часа сжатия нет", async () => {
    st = await stand();
    await st.open("site");
    st.clock.advance(5 * MIN);
    await st.turn(CS, [answer(120_000)]);
    expect(row().cache).toEqual({ until: T0 + 5 * MIN + 60 * MIN });
  });

  // чьё: слово пользователя 11 нояб. — 54-я минута, от 200 К
  it("то же, разговор 212 К: в строке ещё и час сжатия — 54-я минута после ответа", async () => {
    st = await stand();
    await st.open("site");
    await st.turn(CS, [answer(212_000)]);
    expect(row().cache).toEqual({ until: T0 + 60 * MIN, compact: T0 + 54 * MIN });
  });
});

describe("сжатие при простое", () => {
  // чьё: слово пользователя 11 нояб. — «давай спроектируем самостоятельно»: 54-я минута, от 200 К, кэш часовой
  it("разговор 212 К, кэш часовой, сессия простаивает: на 54-й минуте во ввод уходит /compact и строка журнала", async () => {
    st = await stand();
    await st.open("site");
    await st.turn(CS, [answer(212_000)]);
    st.clock.advance(53 * MIN);
    await tick();
    expect(compacts()).toBe(0);
    st.clock.advance(MIN);
    await tick();
    expect(compacts()).toBe(1);
    expect(journal("idle_compact")).toMatchObject([{ callsign: CS, size: 212_000 }]);
  });

  it("разговор 120 К: на 54-й минуте ничего не уходит", async () => {
    st = await stand();
    await st.open("site");
    await st.turn(CS, [answer(120_000)]);
    st.clock.advance(60 * MIN);
    await tick();
    expect(compacts()).toBe(0);
  });

  it("кэш пятиминутный: разговор 212 К не сжимается", async () => {
    st = await stand();
    await st.open("site");
    await st.turn(CS, [answer(212_000, "5m")]);
    st.clock.advance(60 * MIN);
    await tick();
    expect(compacts()).toBe(0);
    expect(row().cache).toEqual({ until: T0 + 5 * MIN });
  });

  it("человек вернулся на 30-й минуте: таймер снят, срок считается от нового ответа", async () => {
    st = await stand();
    await st.open("site");
    await st.turn(CS, [answer(212_000)]);
    st.clock.advance(30 * MIN);
    await st.turn(CS, [answer(214_000)]);
    st.clock.advance(30 * MIN);
    await tick();
    expect(compacts()).toBe(0);
    st.clock.advance(24 * MIN);
    await tick();
    expect(compacts()).toBe(1);
  });

  it("разговор сжат: размер — после сжатия, второй раз он не сжимается", async () => {
    st = await stand();
    await st.open("site");
    await st.turn(CS, [answer(212_000)]);
    st.clock.advance(54 * MIN);
    await tick();
    expect(compacts()).toBe(1);
    await st.turn(CS, [{ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 212_000, post_tokens: 9_000 } }], "");
    expect(row().cache).toEqual({ until: T0 + 54 * MIN + 60 * MIN });
    st.clock.advance(60 * MIN);
    await tick();
    expect(compacts()).toBe(1);
  });

  // устав: после перезапуска модуль и ядро поднимают своё из хранилища
  it("Host подменён на 20-й минуте простоя: таймер взведён из записи сессии, /compact уходит на 54-й минуте от ответа", async () => {
    st = await stand({ sessions: [{ callsign: CS, cache: { at: T0 - 20 * MIN, size: 212_000, hour: true } }] });
    expect(row().cache).toEqual({ until: T0 + 40 * MIN, compact: T0 + 34 * MIN });
    st.clock.advance(33 * MIN);
    await tick();
    expect(compacts()).toBe(0);
    st.clock.advance(MIN);
    await tick();
    expect(compacts()).toBe(1);
  });

  // устав: «система ловит, агент чинит» — догоняющего сжатия нет
  it("Host поднят после срока: строка журнала с причиной, разговор не сжат", async () => {
    st = await stand({ sessions: [{ callsign: CS, cache: { at: T0 - 58 * MIN, size: 212_000, hour: true } }] });
    st.clock.advance(60 * MIN);
    await tick();
    expect(compacts()).toBe(0);
    expect(journal("idle_compact_late")).toHaveLength(1);
    expect(row().cache).toEqual({ until: T0 + 2 * MIN });
  });
});
