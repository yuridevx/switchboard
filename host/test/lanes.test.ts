// Эталоны «Два запаса недели»: очередь — один список аккаунтов и два места на нём; место берёт годный аккаунт с ближним сбросом недели.
// Источники свойств — слова пользователя 11 нояб. 2026 (Fable до 100 % на каждом, «а потом и Opus», «Opus поверх этих 50, если надо продолжить работу»,
// «первыми те, у кого сброс ближе», числа как на странице Claude), замеры ответа Claude и нынешнее поведение кода («чьё: код»).
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { make as accounts } from "../src/modules/accounts/accounts.ts";
import { fits, place, read, type Account } from "../src/modules/accounts/limits.ts";
import { folders } from "../src/modules/accounts/links.ts";
import { FakeQuery } from "../stand/sdk.ts";
import { stand, tick, until, type Stand } from "../stand/index.ts";

const T = 1_800_000_000, DAY = 86_400;
/** Аккаунт рисунка дизайна: s — сколько недели потратил Fable, o — остальные (проценты), d — дней до сброса недели; без d сброс неизвестен. */
function acc(s: number, o: number, d?: number, x: { h?: number; out?: boolean } = {}): Account {
  const resetsAt = d === undefined ? 0 : T + d * DAY;
  const week = { utilization: (s + o) / 100, resetsAt, at: T, fable: s / 100, hold: Math.max(0, Math.min(50 - s, 100 - s - o)) / 100 };
  return { login: x.out ? "none" : "ok", limits: { seven_day: week, fable: { utilization: s / 50, resetsAt, at: T }, ...(x.h ? { five_hour: { utilization: x.h / 100, resetsAt: T + 3600, at: T } } : {}) } };
}
/** Расстановка очереди из аккаунтов по порядку: ответ — номера аккаунтов мест и признак «из запаса Fable». */
function lanes(list: Account[], was: { f?: number; o?: number } = {}) {
  const all = Object.fromEntries(list.map((a, i) => [String(i + 1), a]));
  const name = (i?: number) => (i === undefined ? undefined : String(i));
  const p = place(Object.keys(all), all, { fable: name(was.f), other: name(was.o) }, T);
  return [p.fable ? Number(p.fable) : null, p.other ? Number(p.other) : null, p.over] as const;
}

describe("правило мест очереди", () => {
  it("1. свежая очередь, сброс неизвестен у обоих: оба места на первом по порядку", () => {
    expect(lanes([acc(10, 5), acc(0, 0)])).toEqual([1, 1, false]);
  });
  it("2. сброс ближе — первым: оба места на аккаунте, чья неделя сбросится раньше", () => {
    expect(lanes([acc(10, 5, 5), acc(10, 5, 1), acc(0, 0, 3)])).toEqual([2, 2, false]);
  });
  it("3. неделя ещё не начата: начатые недели тратятся первыми", () => {
    expect(lanes([{ login: "ok", limits: {} }, acc(20, 10, 4)])).toEqual([2, 2, false]);
  });
  it("4. сброс одинаковый: решает порядок человека", () => {
    expect(lanes([acc(5, 5, 3), acc(0, 0, 3)])).toEqual([1, 1, false]);
  });
  it("5. Fable на аккаунте выбран: Fable уходит на следующий, остальные остаются", () => {
    expect(lanes([acc(49, 20), acc(5, 5)], { f: 1, o: 1 })).toEqual([2, 1, false]);
  });
  it("6. остальные выбрали свою половину: уходят на следующий, запас Fable цел, Fable остаётся", () => {
    expect(lanes([acc(20, 49), acc(5, 5)], { f: 1, o: 1 })).toEqual([1, 2, false]);
  });
  it("7. Fable выбран — остальным вся оставшаяся неделя; место Fable без аккаунта", () => {
    expect(lanes([acc(50, 20)], { f: 1, o: 1 })).toEqual([null, 1, false]);
  });
  it("8. остальные выбрали половину на всех: берут запас Fable там, где неделя сбросится раньше", () => {
    expect(lanes([acc(30, 49, 4), acc(10, 49, 1), acc(0, 49, 6)], { f: 1, o: 1 })).toEqual([1, 2, true]);
  });
  it("9. у аккаунта сбросилась неделя: места выбирают заново — остальные на свою половину, Fable туда, где сброс ближе", () => {
    expect(lanes([acc(30, 49, 4), acc(0, 0, 7), acc(10, 60, 2)])).toEqual([3, 2, false]);
  });
  it("10. Fable выбран на всех: место Fable без аккаунта, остальные работают", () => {
    expect(lanes([acc(50, 10), acc(49, 20)], { f: 2, o: 1 })).toEqual([null, 1, false]);
  });
  it("11. выбрано всё: оба места без аккаунта", () => {
    expect(lanes([acc(50, 49), acc(40, 59)], { f: 1, o: 1 })).toEqual([null, null, false]);
  });
  it("12. неделя кончилась раньше лимита Fable (замер 98 и 45): аккаунт закрыт обоим местам", () => {
    expect(lanes([acc(23, 75), acc(5, 5)], { f: 1, o: 1 })).toEqual([2, 2, false]);
  });
  it("13. пять часов у порога: оба места уходят и не возвращаются, пока новый аккаунт годен", () => {
    expect(lanes([acc(10, 10, undefined, { h: 96 }), acc(5, 5)], { f: 1, o: 1 })).toEqual([2, 2, false]);
    expect(lanes([acc(10, 10), acc(5, 5)], { f: 2, o: 2 })).toEqual([2, 2, false]);
  });
  it("14. вход аккаунта пропал: оба места уходят на следующий вошедший", () => {
    expect(lanes([acc(10, 10, undefined, { out: true }), acc(5, 5)], { f: 1, o: 1 })).toEqual([2, 2, false]);
  });
  it("15. человек поставил место: оно стоит, где поставили, пока аккаунт годен", () => {
    expect(lanes([acc(10, 10), acc(5, 5), acc(0, 0)], { f: 3, o: 1 })).toEqual([3, 1, false]);
  });
  it("16. числа — как на странице Claude: неделя 47, Fable 74, доля Fable 37, запас 13; ответ без доли Fable — Fable цел, потолок половина недели", () => {
    const measured = read({ rate_limits: { five_hour: null, seven_day: { utilization: 47, resets_at: "2026-11-17T10:00:00Z" }, model_scoped: [{ display_name: "Fable", utilization: 74 }], weekly_scoped_shares: [{ used_percent_of_weekly: 37, allowance_percent_of_weekly: 50 }] } }, T);
    expect(measured.seven_day).toMatchObject({ utilization: 0.47, fable: 0.37 });
    expect(measured.seven_day!.hold).toBeCloseTo(0.13);
    expect(measured.fable).toMatchObject({ utilization: 0.74, resetsAt: Date.parse("2026-11-17T10:00:00Z") / 1000 });
    expect(measured.five_hour).toBeUndefined();
    const bare = read({ rate_limits: { seven_day: { utilization: 30, resets_at: null } } }, T);
    expect(bare.seven_day).toMatchObject({ utilization: 0.3, fable: 0, hold: 0.5 });
    expect(bare.fable!.utilization).toBe(0);
    expect(fits({ login: "ok", limits: bare }, "fable", T)).toBe(true);
    // пустой ответ чисел не пишет
    expect(read({}, T)).toEqual({});
  });
});

let st: Stand | undefined;
const USAGE = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
const usage = (FakeQuery.prototype as any)[USAGE];
afterEach(async () => {
  await st?.stop();
  st = undefined;
  (FakeQuery.prototype as any)[USAGE] = usage;
});

const A = "a@example.com", B = "b@example.com";
const sec = () => Math.floor(Date.now() / 1000);
/** Ответы Claude о лимитах по аккаунтам: неделя, Fable и доля Fable в неделе, проценты. Ответ — сколько раз спросили каждый. */
function claudeSays(by: Record<string, { week: number; fable: number; share: number }>): Record<string, number> {
  const asked: Record<string, number> = {};
  (FakeQuery.prototype as any)[USAGE] = async function (this: FakeQuery) {
    const name = basename(String((this.options as any).env.CLAUDE_CONFIG_DIR));
    asked[name] = (asked[name] ?? 0) + 1;
    const x = by[name];
    const resets_at = new Date((sec() + DAY) * 1000).toISOString();
    return x ? { rate_limits: { seven_day: { utilization: x.week, resets_at }, model_scoped: [{ display_name: "Fable", utilization: x.fable, resets_at }], weekly_scoped_shares: [{ used_percent_of_weekly: x.share, allowance_percent_of_weekly: 50 }] } } : {};
  };
  return asked;
}
function home(names: string[], limits: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "sb2-host-"));
  mkdirSync(join(dir, "store"), { recursive: true });
  const book = { accounts: Object.fromEntries(names.map((n) => [n, { login: "ok", plan: "max", limits: limits[n] ?? {}, ...(extra[n] as object) }])), slots: { main: names } };
  writeFileSync(join(dir, "store", "host-accounts.json"), JSON.stringify({ machine: book }));
  const dirs = folders(dir);
  mkdirSync(join(dir, "slots"), { recursive: true });
  for (const n of names) mkdirSync(dirs.accDir(n), { recursive: true });
  for (const lane of ["fable", "other"] as const) symlinkSync(dirs.accDir(names[0]!), dirs.laneDir("main", lane), process.platform === "win32" ? "junction" : "dir");
  return dir;
}
const envOf = (callsign: string) => (st!.sdk.last(callsign)!.options as any).env as Record<string, string>;
const slotOf = async () => ((await st!.request("account.list", { to: "@laptop" })).result as any).slots[0] as { lanes: Record<"fable" | "other", { account?: string; wait?: number; over?: boolean }> };

describe("два места очереди", () => {
  it("17. сессия идёт на месте своей модели: без модели — Fable и вход места fable; Opus — вход места other; очередь модель не ограничивает", async () => {
    const dir = home([A]);
    st = await stand({ home: dir, modules: [accounts()] });
    await st.open("site");
    await st.open("docs", { model: "claude-opus-5-5" });
    expect(envOf("site@laptop")).toMatchObject({ ANTHROPIC_MODEL: "fable", CLAUDE_SECURESTORAGE_CONFIG_DIR: folders(dir).laneDir("main", "fable") });
    expect(envOf("docs@laptop").CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(folders(dir).laneDir("main", "other"));
    expect(envOf("docs@laptop").ANTHROPIC_MODEL).toBeUndefined();
  });

  it("18. сессия сменила модель с Fable на Opus: процесс перезапущен со входом другого места, разговор тот же; смена внутри места перезапуска не даёт", async () => {
    const dir = home([A]);
    st = await stand({ home: dir, modules: [accounts()] });
    const { s } = await st.open("site", { model: "claude-fable-5-2" });
    const id = s.rec.sessionId;
    expect((await st.request("session.update", { to: "site@laptop", patch: { model: "claude-opus-5-5" } })).ok).toBe(true);
    await until(() => st!.sdk.of("site@laptop").length === 2, 5000, "перезапуск на месте остальных");
    expect(envOf("site@laptop").CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(folders(dir).laneDir("main", "other"));
    expect(s.rec.sessionId).toBe(id);
    expect((await st.request("session.update", { to: "site@laptop", patch: { model: "claude-haiku-5-5" } })).ok).toBe(true);
    await tick(50);
    expect(st.sdk.of("site@laptop")).toHaveLength(2);
  });

  it("19. сессия работает, числам её аккаунта больше двух минут: один вопрос Claude; Fable у порога — место Fable уходит, место остальных стоит; второй раз в две минуты не спрашиваем", async () => {
    const dir = home([A, B], {}, { [B]: { asked: sec() } });
    const asked = claudeSays({ [A]: { week: 60, fable: 99, share: 49 }, [B]: { week: 10, fable: 10, share: 5 } });
    st = await stand({ home: dir, modules: [accounts()] });
    const one = await st.open("site");
    await st.open("docs", { model: "claude-opus-5-5" });
    one.proc.send({ type: "assistant", message: { content: [] } });
    await until(() => folders(dir).inLane("main", "fable") === B, 5000, "место Fable ушло на следующий аккаунт");
    expect(folders(dir).inLane("main", "other")).toBe(A);
    expect(st.link.rows("site@laptop").at(-1)!.row).toMatchObject({ account: B });
    expect(st.link.rows("docs@laptop").at(-1)!.row).toMatchObject({ account: A });
    one.proc.send({ type: "assistant", message: { content: [] } });
    await tick(50);
    expect(asked[A]).toBe(1);
  });

  it("20. остальные выбрали свою половину на всех аккаунтах: место остальных берёт запас Fable, очередь говорит об этом; Fable выбран везде — место Fable ждёт сброса", async () => {
    const at = sec(), reset = at + 600;
    const week = (used: number, fable: number, hold: number) => ({ seven_day: { utilization: used, resetsAt: reset, at, fable, hold }, fable: { utilization: fable / 0.5, resetsAt: reset, at } });
    const dir = home([A], { [A]: week(0.69, 0.2, 0.3) }, { [A]: { asked: at } });
    st = await stand({ home: dir, modules: [accounts()] });
    st.services.handlers["keys.list"] = () => ({ keys: [] });
    expect((await slotOf()).lanes).toEqual({ fable: { account: A }, other: { account: A, over: true } });
    st.kernel.disk.section<any>("host-accounts").update((b: any) => ({ ...b, accounts: { [A]: { ...b.accounts[A], limits: week(0.7, 0.5, 0) } } }));
    await st.open("site");
    expect((await slotOf()).lanes).toEqual({ fable: { account: A, wait: reset * 1000 }, other: { account: A } });
    expect(st.link.rows("site@laptop").at(-1)!.row).toMatchObject({ account: A, wait: reset * 1000 });
  });

  it("21. отказ Claude по лимиту Fable: уходит только место Fable, его сессия продолжает на новом аккаунте", async () => {
    const dir = home([A, B], {}, { [A]: { asked: sec() }, [B]: { asked: sec() } });
    st = await stand({ home: dir, modules: [accounts()] });
    const { proc } = await st.open("site");
    proc.send({ type: "system", subtype: "session_state_changed", state: "running" });
    proc.send({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day_overage_included", resetsAt: sec() + 3600 } });
    proc.send({ type: "system", subtype: "session_state_changed", state: "idle" });
    await until(() => folders(dir).inLane("main", "fable") === B, 5000, "место Fable ушло");
    await until(() => proc.inputs.some((i) => i.message.content === "Продолжай"), 5000, "продолжение");
    expect(folders(dir).inLane("main", "other")).toBe(A);
  });

  it("23. служба запустилась, а ссылок мест у очереди ещё нет: сессия дожидается расстановки и идёт, а не падает", async () => {
    const dir = home([A]);
    for (const lane of ["fable", "other"] as const) await folders(dir).unplace("main", lane);
    // Claude отвечает о лимитах не сразу: расстановка на старте ещё идёт, когда сессия запускается
    (FakeQuery.prototype as any)[USAGE] = () => new Promise((r) => setTimeout(() => r({}), 400));
    st = await stand({ home: dir, modules: [accounts()] });
    const { s } = await st.open("site", { model: "claude-opus-5-5" });
    expect(s.state).not.toBe("failed");
    expect(folders(dir).inLane("main", "other")).toBe(A);
    expect(envOf("site@laptop").CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(folders(dir).laneDir("main", "other"));
  });

  it("22. сбросилась неделя аккаунта: места выбирают заново — при равных решает порядок", async () => {
    const at = sec();
    const full = { seven_day: { utilization: 1, resetsAt: at + 1, at, fable: 0.2, hold: 0 }, fable: { utilization: 0.4, resetsAt: at + 1, at } };
    const dir = home([A, B], { [A]: full }, { [A]: { asked: at + 3600 }, [B]: { asked: at + 3600 } });
    const dirs = folders(dir);
    for (const lane of ["fable", "other"] as const) await dirs.place("main", lane, B);
    st = await stand({ home: dir, modules: [accounts()] });
    await st.open("site");
    expect(dirs.inLane("main", "fable")).toBe(B);
    await until(() => dirs.inLane("main", "fable") === A && dirs.inLane("main", "other") === A, 6000, "после сброса места выбраны заново");
  });
});
