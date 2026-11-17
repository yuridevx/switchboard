// Эталоны: «ход с ответом» (ядро), кэш разговора и сжатие при простое (хозяин пары «провайдер · модель»).
// Источник — дизайны «Сжатие при простое», «Аккаунты и модели» и «Свободная смена модели» (эталоны 11–13).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { make as accounts } from "../src/modules/accounts/accounts.ts";
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
const FABLE = "claude-fable-5-2";
const row = () => st!.link.rows(CS).at(-1)!.row as any;
/** Сколько ответ читает из кэша: остальное — запись и новый ввод. */
const READ = (size: number) => size - 6402;
/** Ответ модели в основном разговоре: размер разговора и срок кэша — как их называет Claude. */
const answer = (size: number, ttl: "1h" | "5m" = "1h", model = FABLE) => ({
  type: "assistant", uuid: `a-${size}-${Math.random()}`, parent_tool_use_id: null,
  message: { model, content: [{ type: "text", text: "готово" }], usage: { input_tokens: 2, cache_read_input_tokens: READ(size), cache_creation_input_tokens: 6400, cache_creation: { ephemeral_1h_input_tokens: ttl === "1h" ? 6400 : 0, ephemeral_5m_input_tokens: ttl === "5m" ? 6400 : 0 } } },
});
/** Ответ стороннего провайдера: чтение из кэша есть, записи и срока нет. */
const foreign = (size: number, read: number, model = "grok-4.5") => ({
  type: "assistant", uuid: `f-${size}-${Math.random()}`, parent_tool_use_id: null,
  message: { model, content: [{ type: "text", text: "готово" }], usage: { input_tokens: size - read, cache_read_input_tokens: read, cache_creation_input_tokens: 0 } },
});
const compacts = () => st!.proc(CS).inputs.filter((i) => i.message.content === "/compact").length;
const journal = (msg: string) => st!.journal().filter((l) => l.msg === msg);
const CATALOG = [{ id: FABLE, window: 1_000_000, protocol: "claude" }, { id: "claude-haiku-5-5", window: 200_000, protocol: "claude" }];
const ORCA = [{ id: "grok-4.5", window: 200_000, protocol: "openai" }];

/** Стенд с хозяином пары: каталог Claude и провайдер orca; cache — срок кэша на ключе orca, минуты. */
async function fleet(o: { home?: string; sessions?: Array<{ callsign: string; spec: Record<string, unknown> }>; cache?: number } = {}): Promise<void> {
  st = await stand({ modules: [accounts()], ...(o.home ? { home: o.home } : {}), ...(o.sessions ? { sessions: o.sessions as never } : {}), start: false });
  st.services.handlers["keys.list"] = () => ({ keys: [{ name: "orca", protocol: "openai", at: 1, tail: "tail" }] });
  st.services.handlers["keys.value"] = () => ({ value: "sk-orca", protocol: "openai", base: "https://api.orca.example", ...(o.cache ? { cache: o.cache } : {}) });
  st.services.handlers["keys.models"] = (f: any) => ({ models: f.name === "claude" ? CATALOG : ORCA });
  await st.kernel.start();
}
const open = (spec: Record<string, unknown> = { key: "claude", model: FABLE }) => st!.open("site", spec);
/** Запись хозяина пары до старта Host: сессия прежнего Host с кэшем. */
function before(at: number): { home: string; sessions: Array<{ callsign: string; spec: Record<string, unknown> }> } {
  const home = mkdtempSync(join(tmpdir(), "sb2-host-"));
  mkdirSync(join(home, "store"), { recursive: true });
  const pair = { key: "claude", model: FABLE, protocol: "claude", window: 1_000_000 };
  writeFileSync(join(home, "store", "host-accounts.json"), JSON.stringify({ sessions: { [CS]: { pair, cache: { at, size: 212_000, read: 205_598, ttl: 60 * MIN, model: FABLE } } } }));
  return { home, sessions: [{ callsign: CS, spec: { name: "site", cwd: join(home, "work"), key: "claude", model: FABLE } }] };
}

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
    await fleet();
    await open();
    st!.clock.advance(5 * MIN);
    await st!.turn(CS, [answer(120_000)]);
    expect(row().cache).toEqual({ until: T0 + 5 * MIN + 60 * MIN, size: 120_000, read: READ(120_000) });
  });

  // чьё: слово пользователя 11 нояб. — 54-я минута, от 200 К
  it("то же, разговор 212 К: в строке ещё и час сжатия — 54-я минута после ответа", async () => {
    await fleet();
    await open();
    await st!.turn(CS, [answer(212_000)]);
    expect(row().cache).toEqual({ until: T0 + 60 * MIN, compact: T0 + 54 * MIN, size: 212_000, read: READ(212_000) });
  });
});

describe("кэш на любой модели", () => {
  // эталон 11 — чьё: слово пользователя 17 нояб. — «на всех моделях должен работать горячий кэш-индикатор»; факт опыта — сторонние называют чтения из кэша, срок — нет
  it("ответ стороннего с чтением из кэша: срок на ключе задан — тёплый на этот срок; не задан — в строке только размер и прочитанное", async () => {
    await fleet({ cache: 10 });
    await open({ key: "orca", model: "grok-4.5" });
    await st!.turn(CS, [foreign(40_000, 38_000)]);
    expect(row().cache).toEqual({ until: T0 + 10 * MIN, size: 40_000, read: 38_000 });
    await st!.stop();
    await fleet();
    await open({ key: "orca", model: "grok-4.5" });
    await st!.turn(CS, [foreign(40_000, 38_000)]);
    expect(row().cache).toEqual({ size: 40_000, read: 38_000 });
  });

  // эталон 12 — чьё: факт опыта 17 нояб. — срок кэша доставался новой модели от прежней
  it("смена модели: кэш холодный до первого ответа новой модели, срок прежней не наследуется", async () => {
    await fleet();
    await open();
    await st!.turn(CS, [answer(120_000)]);
    expect(row().cache.until).toBe(T0 + 60 * MIN);
    expect(await st!.request("session.update", { to: CS, patch: { key: "orca", model: "grok-4.5" } })).toMatchObject({ ok: true });
    expect(row().cache).toBeUndefined();
    await st!.turn(CS, [foreign(121_000, 0)]);
    expect(row().cache).toEqual({ size: 121_000, read: 0 });
  });

  // эталон 13 — чьё: слово пользователя 17 нояб. — «правильный размер контекста и сжатия на всех моделях»; правило 11 нояб. — от 200 К, за 6 минут до конца срока
  it("сторонний провайдер, срок кэша 30 минут, разговор 212 К: «/compact» уходит на 24-й минуте", async () => {
    await fleet({ cache: 30 });
    await open({ key: "orca", model: "grok-4.5" });
    await st!.turn(CS, [foreign(212_000, 200_000)]);
    expect(row().cache).toEqual({ until: T0 + 30 * MIN, compact: T0 + 24 * MIN, size: 212_000, read: 200_000 });
    st!.clock.advance(23 * MIN);
    await tick();
    expect(compacts()).toBe(0);
    st!.clock.advance(MIN);
    await tick();
    expect(compacts()).toBe(1);
  });
});

describe("сжатие при простое", () => {
  // чьё: слово пользователя 11 нояб. — «давай спроектируем самостоятельно»: 54-я минута, от 200 К, кэш часовой
  it("разговор 212 К, кэш часовой, сессия простаивает: на 54-й минуте во ввод уходит /compact и строка журнала", async () => {
    await fleet();
    await open();
    await st!.turn(CS, [answer(212_000)]);
    st!.clock.advance(53 * MIN);
    await tick();
    expect(compacts()).toBe(0);
    st!.clock.advance(MIN);
    await tick();
    expect(compacts()).toBe(1);
    expect(journal("idle_compact")).toMatchObject([{ callsign: CS, size: 212_000 }]);
  });

  it("разговор 120 К: на 54-й минуте ничего не уходит", async () => {
    await fleet();
    await open();
    await st!.turn(CS, [answer(120_000)]);
    st!.clock.advance(60 * MIN);
    await tick();
    expect(compacts()).toBe(0);
  });

  it("кэш пятиминутный: разговор 212 К не сжимается", async () => {
    await fleet();
    await open();
    await st!.turn(CS, [answer(212_000, "5m")]);
    st!.clock.advance(60 * MIN);
    await tick();
    expect(compacts()).toBe(0);
    expect(row().cache).toEqual({ until: T0 + 5 * MIN, size: 212_000, read: READ(212_000) });
  });

  it("человек вернулся на 30-й минуте: таймер снят, срок считается от нового ответа", async () => {
    await fleet();
    await open();
    await st!.turn(CS, [answer(212_000)]);
    st!.clock.advance(30 * MIN);
    await st!.turn(CS, [answer(214_000)]);
    st!.clock.advance(30 * MIN);
    await tick();
    expect(compacts()).toBe(0);
    st!.clock.advance(24 * MIN);
    await tick();
    expect(compacts()).toBe(1);
  });

  it("разговор сжат: размер — после сжатия, второй раз он не сжимается", async () => {
    await fleet();
    await open();
    await st!.turn(CS, [answer(212_000)]);
    st!.clock.advance(54 * MIN);
    await tick();
    expect(compacts()).toBe(1);
    await st!.turn(CS, [{ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 212_000, post_tokens: 9_000 } }], "");
    expect(row().cache).toEqual({ until: T0 + 54 * MIN + 60 * MIN, size: 9_000, read: READ(212_000) });
    st!.clock.advance(60 * MIN);
    await tick();
    expect(compacts()).toBe(1);
  });

  // устав: после перезапуска модуль и ядро поднимают своё из хранилища
  it("Host подменён на 20-й минуте простоя: таймер взведён из записи сессии, /compact уходит на 54-й минуте от ответа", async () => {
    await fleet(before(T0 - 20 * MIN));
    expect(row().cache).toEqual({ until: T0 + 40 * MIN, compact: T0 + 34 * MIN, size: 212_000, read: 205_598 });
    st!.clock.advance(33 * MIN);
    await tick();
    expect(compacts()).toBe(0);
    st!.clock.advance(MIN);
    await tick();
    expect(compacts()).toBe(1);
  });

  // устав: «система ловит, агент чинит» — догоняющего сжатия нет
  it("Host поднят после срока: строка журнала с причиной, разговор не сжат", async () => {
    await fleet(before(T0 - 58 * MIN));
    st!.clock.advance(60 * MIN);
    await tick();
    expect(compacts()).toBe(0);
    expect(journal("idle_compact_late")).toHaveLength(1);
    expect(row().cache).toEqual({ until: T0 + 2 * MIN, size: 212_000, read: 205_598 });
  });
});
