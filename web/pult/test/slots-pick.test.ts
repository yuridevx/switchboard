// Эталоны строки выбора слота и частичного ответа машин: дизайн «Предел чтений и слоты», номера — как в его таблице.
import { describe, expect, it } from "vitest";
import { machineAnswers, okOf, slotChoice, wordOf, type Result } from "@switchboard/web-ui";
import { fleetRelay, fleetRoster, flush, pult, SLOTS } from "./stand.ts";

const slot = (wait: number | null = null) => ({ account: "a", order: ["a"], wait, sessions: [] });
const named = async (t: Awaited<ReturnType<typeof pult>>, name: string) => {
  const nm = t.$<HTMLInputElement>('[data-f="name"]')!;
  await t.type(nm, name);
};
const start = (t: Awaited<ReturnType<typeof pult>>) => t.click(t.$('[data-act="open"]'));

function openRelay(slots: Record<string, unknown> | null) {
  const relay = fleetRelay();
  if (slots) relay.handlers[SLOTS] = () => ({ ok: true, result: { slots } });
  relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: {}, repos: {} } });
  relay.handlers["machine.dirs"] = (f) => ({ ok: true, result: { path: f.path, dirs: [] } });
  relay.handlers["session.open"] = (f) => ({ ok: true, result: { callsign: `${f.name}@${f.machine}` } });
  return relay;
}
async function openForm(relay: ReturnType<typeof fleetRelay>) {
  const t = await pult({ relay });
  await t.go("#open?machine=laptop");
  await flush(10);
  return t;
}

describe("строка выбора слота", () => {
  it("E24 · slotChoice: один слот — поля нет; два — первый; выбранный и текущий главнее", () => {
    // источник: слово пользователя 4 нояб.: форма и окна подъёма отмечают первый слот
    expect(slotChoice([])).toBe("");
    expect(slotChoice(["main"], "main")).toBe("");
    expect(slotChoice(["main", "bot"])).toBe("main");
    expect(slotChoice(["main", "bot"], "bot")).toBe("bot");
    expect(slotChoice(["main", "bot"], "night")).toBe("main");
  });

  it("E24 · форма: 1 слот — строки нет, запрос без поля", async () => {
    const relay = openRelay({ main: slot() });
    const t = await openForm(relay);
    await t.click(t.$('[data-pop="model"]'));
    expect(t.$("[data-slot-pick]")).toBeNull();
    await named(t, "a");
    await start(t);
    expect(relay.sent("session.open")[0]).not.toHaveProperty("slot");
  });

  it("E24 · форма: 2 слота, человек не менял выбор — отмечен первый, запрос с ним; выбрал другой — с другим", async () => {
    const relay = openRelay({ main: slot(), bot: slot() });
    const t = await openForm(relay);
    await t.click(t.$('[data-pop="model"]'));
    expect(t.$('[data-slot="main"]')!.getAttribute("aria-pressed")).toBe("true");
    await t.click(t.$('[data-slot="bot"]'));
    expect(t.$('[data-slot="bot"]')!.getAttribute("aria-pressed")).toBe("true");
    await named(t, "a");
    await start(t);
    expect(relay.sent("session.open")[0]).toMatchObject({ slot: "bot" });
  });

  it("E24 · единственный слот ждёт сброса: строки нет, подпись на чипе и в окне", async () => {
    const relay = openRelay({ main: slot(1793666400) });
    const t = await openForm(relay);
    expect(t.$('[data-pop="model"]')!.textContent).toContain("main · ждёт сброса");
    await t.click(t.$('[data-pop="model"]'));
    expect(t.$("[data-slot-wait]")!.textContent).toContain("main · ждёт сброса");
  });

  it("E15 · список слотов не пришёл, машина с двумя слотами: запрос без поля, «Выберите слот», список перечитан один раз", async () => {
    // источник: чьё: код; дизайн — форма не заходит в тупик
    const relay = openRelay({ main: slot(), bot: slot() });
    const of = relay.handlers[SLOTS];
    let silent = true;
    relay.handlers[SLOTS] = (f) => (silent ? { ok: false, error: "timeout" } : of(f));
    relay.handlers["session.open"] = () => ({ ok: false, error: "slot_required", why: "Слоты машины: main, bot" });
    const t = await openForm(relay);
    await named(t, "a");
    silent = false;
    const asked = relay.sent("machine.accounts").length;
    await start(t);
    await flush(10);
    expect(relay.sent("session.open")[0]).not.toHaveProperty("slot");
    expect(t.text()).toContain("Выберите слот");
    expect(relay.sent("machine.accounts").length).toBe(asked + 1);
    expect(t.$('[data-slot="main"]')!.getAttribute("aria-pressed")).toBe("true");
  });

  it("E21 · отказ машины с причиной виден на форме", async () => {
    const relay = openRelay({ main: slot() });
    relay.handlers["session.open"] = () => ({ ok: false, error: "not_logged_in", why: "в слоте main никого" });
    const t = await openForm(relay);
    await named(t, "a");
    await start(t);
    await flush(5);
    expect(t.text()).toContain("session.open: not_logged_in — в слоте main никого");
  });
});

describe("ответы машин", () => {
  const stand = () => {
    const answers: Array<(r: Result<{ n: number }>) => void> = [];
    let machines = ["laptop"];
    const m = machineAnswers<{ n: number }>({ roster: () => fleetRoster(), changed: () => {} }, () => new Promise((ok) => answers.push(ok)), () => machines);
    return { m, answers, set: (x: string[]) => (machines = x) };
  };

  it("E32 · отказ чтения: прежний ответ рядом со словом", async () => {
    // источник: факт — обрывы раз в 4,8 мин стирали экран машины
    const { m, answers } = stand();
    const a = m.reload("laptop");
    answers[0]({ ok: true, result: { n: 1 } });
    await a;
    const b = m.reload("laptop");
    answers[1]({ ok: false, error: "timeout" });
    await b;
    expect(wordOf(m.get().laptop)).toBe("timeout");
    expect(okOf(m.get().laptop)).toEqual({ n: 1 });
  });

  it("E32 · вопрос, ушедший раньше, отказал позже свежего ответа — свежий не затёрт", async () => {
    const { m, answers } = stand();
    const old = m.reload("laptop");
    const fresh = m.reload("laptop");
    answers[1]({ ok: true, result: { n: 2 } });
    await fresh;
    answers[0]({ ok: false, error: "timeout" });
    await old;
    expect(m.get().laptop).toEqual({ n: 2 });
  });

  it("E32 · связь вернулась: машину с timeout спросить снова; ответившую — нет", async () => {
    const { m, answers, set } = stand();
    set(["laptop", "pc"]);
    const stop = m.mount();
    answers[0]({ ok: false, error: "timeout" });
    answers[1]({ ok: true, result: { n: 1 } });
    await flush(2);
    m.onLink("open");
    expect(answers).toHaveLength(3);
    stop();
  });
});
