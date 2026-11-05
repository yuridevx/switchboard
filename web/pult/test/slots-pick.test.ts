// Эталоны строки выбора слота и частичного ответа машин: дизайн «Предел чтений и слоты», номера — как в его таблице.
import { describe, expect, it } from "vitest";
import { machineAnswers, okOf, slotChoice, wordOf, type Result } from "@switchboard/web-ui";
import { fleetRelay, fleetRoster, flush, pult, SLOTS } from "./stand.ts";

describe("строка выбора слота", () => {
  it("E24 · slotChoice: один слот — поля нет; два — первый; выбранный и текущий главнее", () => {
    // источник: слово пользователя 4 нояб.: форма и окна подъёма отмечают первый слот
    expect(slotChoice([])).toBe("");
    expect(slotChoice(["main"], "main")).toBe("");
    expect(slotChoice(["main", "bot"])).toBe("main");
    expect(slotChoice(["main", "bot"], "bot")).toBe("bot");
    expect(slotChoice(["main", "bot"], "night")).toBe("main");
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
