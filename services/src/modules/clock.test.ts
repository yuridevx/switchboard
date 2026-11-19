// Эталоны часов флота: правила времени лежат в записях, будильник у объекта один, срок приходит без запроса.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type TimerRow } from "@sb/protocol";
import type { Outside } from "../env.ts";
import { type Stand, stand } from "../../test/stand.ts";
import { drop, ensure, fire, next, on, set } from "./clock/clock.ts";

/** Что сработало: по флоту — имена правил в порядке вызова. */
const rang = new Map<string, string[]>();
on("test.ring", async (_env, fleet, input, w) => void rang.set(fleet, [...(rang.get(fleet) ?? []), `${w.id}${input === undefined ? "" : ":" + JSON.stringify(input)}`]));
on("test.fail", async () => {
  throw new Error("работа упала");
});

const errors: string[] = [];
const outside = (s: Stand): Outside => ({ platform: s.platform, fetch: s.deps.fetch!, log: { info() {}, warn() {}, error: (msg: string) => void errors.push(msg), with() { return this; } } as never });
const object = (s: Stand) => s.env.RECORDS.get(s.env.RECORDS.idFromName(`${s.fleet}/clock`));
const alarmOf = (s: Stand) => runInDurableObject(object(s), (_o, state) => state.storage.getAlarm());
const timers = async (s: Stand, prefix?: string) => ((await s.ask("clock.list", prefix ? { prefix } : {})).result as { timers: TimerRow[] }).timers;

describe("часы флота", () => {
  // эталон 8 — чьё: факт (таймеры в разговорах сессий пересоздавали 57 раз в трёх проектах за неделю: они жили, пока жив процесс)
  it("8 · правило стоит в записях и срабатывает по будильнику без запроса; пропущено два срока — срабатывание одно, следующий срок от «сейчас»", async () => {
    const s = stand();
    const t = Date.now();
    await set(s.env, s.fleet, { id: "round", kind: "test.ring", every: 60_000 }, t);
    expect(await alarmOf(s)).toBe(t + 60_000);
    // будильник раньше срока правила не трогает
    expect(await runDurableObjectAlarm(object(s))).toBe(true);
    expect(rang.get(s.fleet)).toBeUndefined();
    // службы молчали две с половиной минуты: два срока прошли без единого срабатывания
    const real = Date.now;
    Date.now = () => t + 150_000;
    try {
      expect(await runDurableObjectAlarm(object(s))).toBe(true);
    } finally {
      Date.now = real;
    }
    expect(rang.get(s.fleet)).toEqual(["round"]);
    expect(await timers(s)).toMatchObject([{ id: "round", kind: "test.ring", every: 60_000, at: t + 210_000 }]);
    expect(await alarmOf(s)).toBe(t + 210_000);
    await drop(s.env, s.fleet, { id: "round" });
    expect(await alarmOf(s)).toBeNull();
  });

  it("десять правил на одном будильнике: он стоит на ближайшем сроке; срок пришёл троим — сработали трое, будильник встал на четвёртого", async () => {
    const s = stand();
    const t = Date.now() + 3600_000;
    for (let i = 10; i >= 1; i--) await set(s.env, s.fleet, { id: `r${String(i).padStart(2, "0")}`, kind: "test.ring", at: t + i * 60_000, input: { n: i } });
    expect(await alarmOf(s)).toBe(t + 60_000);
    expect(await fire(s.env, s.fleet, outside(s), t + 3.5 * 60_000)).toBe(3);
    expect(rang.get(s.fleet)).toEqual(['r01:{"n":1}', 'r02:{"n":2}', 'r03:{"n":3}']);
    // разовое правило после срока снято
    expect((await timers(s)).map((x) => x.id)).toEqual(["r04", "r05", "r06", "r07", "r08", "r09", "r10"]);
    expect(await alarmOf(s)).toBe(t + 4 * 60_000);
    // снять по началу имени — будильника нет
    await drop(s.env, s.fleet, { prefix: "r" });
    expect(await timers(s)).toEqual([]);
    expect(await alarmOf(s)).toBeNull();
  });

  it("расписание в часовом поясе: «по понедельникам в 09:00» по Киеву; негодная строка — отказ словом", () => {
    // четверг 19 ноября 2026, 12:00 UTC → понедельник 23 ноября, 09:00 Киева = 07:00 UTC
    expect(next({ cron: "0 9 * * 1", tz: "Europe/Kyiv" }, Date.UTC(2026, 10, 19, 12, 0))).toBe(Date.UTC(2026, 10, 23, 7, 0));
    // без пояса — UTC
    expect(next({ cron: "0 9 * * 1" }, Date.UTC(2026, 10, 19, 12, 0))).toBe(Date.UTC(2026, 10, 23, 9, 0));
    expect(() => next({ cron: "каждый день" }, Date.now())).toThrowError(/расписание/);
  });

  it("сбой одной работы другой не мешает и срабатывание не повторяет: следующий срок записан раньше вызова", async () => {
    const s = stand();
    const t = Date.now() + 3600_000;
    await set(s.env, s.fleet, { id: "a-fail", kind: "test.fail", every: 60_000 }, t - 60_000);
    await set(s.env, s.fleet, { id: "b-ring", kind: "test.ring", every: 60_000 }, t - 60_000);
    const before = errors.length;
    expect(await fire(s.env, s.fleet, outside(s), t)).toBe(2);
    expect(rang.get(s.fleet)).toEqual(["b-ring"]);
    expect(errors.slice(before)).toEqual(["часы: работа по сроку упала"]);
    // тот же момент ещё раз — срок обоих уже впереди
    expect(await fire(s.env, s.fleet, outside(s), t)).toBe(0);
    expect((await timers(s)).map((x) => [x.id, x.at])).toEqual([["a-fail", t + 60_000], ["b-ring", t + 60_000]]);
    await drop(s.env, s.fleet, { prefix: "" });
  });

  it("правило вида без хозяина в этой сборке остаётся на месте; о нём строка ошибки", async () => {
    const s = stand();
    const t = Date.now() + 3600_000;
    await set(s.env, s.fleet, { id: "orphan", kind: "test.gone", every: 60_000 }, t - 60_000);
    const before = errors.length;
    expect(await fire(s.env, s.fleet, outside(s), t)).toBe(1);
    expect(errors.slice(before)).toEqual(["часы: у вида правила нет хозяина в этой сборке"]);
    expect((await timers(s)).map((x) => x.id)).toEqual(["orphan"]);
    await drop(s.env, s.fleet, { id: "orphan" });
  });

  it("завести один раз: существующее правило не трогается; поставить — заменяет; срок «каждые 0» — отказ", async () => {
    const s = stand();
    const t = Date.now() + 3600_000;
    await ensure(s.env, s.fleet, { id: "once", kind: "test.ring", every: 60_000 }, t);
    await ensure(s.env, s.fleet, { id: "once", kind: "test.ring", every: 5_000 }, t);
    expect(await timers(s)).toMatchObject([{ id: "once", every: 60_000, at: t + 60_000 }]);
    await set(s.env, s.fleet, { id: "once", kind: "test.ring", every: 5_000 }, t);
    expect(await timers(s)).toMatchObject([{ id: "once", every: 5_000, at: t + 5_000 }]);
    await expect(set(s.env, s.fleet, { id: "zero", kind: "test.ring", every: 0 }, t)).rejects.toMatchObject({ word: "bad_input" });
    // список отбирается по началу имени
    await set(s.env, s.fleet, { id: "other", kind: "test.ring", at: t + 1 }, t);
    expect((await timers(s, "on")).map((x) => x.id)).toEqual(["once"]);
    await drop(s.env, s.fleet, { prefix: "" });
  });
});
